import {$, canvasContext, palette} from './utils.js';

const same = (a, b) => a[0] === b[0] && a[1] === b[1];
export const onWire = ([x, y], [[ax, ay], [bx, by]]) =>
  (x-ax)*(by-ay) === (y-ay)*(bx-ax) &&
  x >= Math.min(ax,bx) && x <= Math.max(ax,bx) && y >= Math.min(ay,by) && y <= Math.max(ay,by);
export const route = (from, to) => [[from, [to[0], from[1]]], [[to[0], from[1]], to]]
  .filter(([a,b]) => !same(a,b));

export function createSheet(state, callbacks) {
  const canvas = $('schematic');
  let scale = 22, origin = [0, 0], cursor, gesture;
  const xy = ([x,y]) => [origin[0]+x*scale, origin[1]+y*scale];
  const grid = ([x,y]) => [Math.round((x-origin[0])/scale), Math.round((y-origin[1])/scale)];
  const local = event => [event.offsetX, event.offsetY];
  const distance = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
  const points = () => [...state.pins.flat(), ...state.project.wires.flat(), ...state.project.junctions];

  function hit(point, pixel) {
    const pin = state.pins.flatMap((pins,i) => pins.map((p,j) => ({p,i,j})))
      .find(({p}) => distance(xy(p), pixel) < 10);
    if (pin) return {kind: 'parts', index: pin.i, pin: pin.j};
    const junction = state.project.junctions.findIndex(p => same(p,point));
    if (junction >= 0) return {kind: 'junctions', index: junction};
    const part = state.project.parts.findIndex(p => {
      const [x,y] = xy([p.x,p.y]);
      return Math.abs(x-pixel[0]) < scale*1.1 && Math.abs(y-pixel[1]) < scale*.85;
    });
    if (part >= 0) return {kind:'parts', index:part};
    const wire = state.project.wires.findIndex(w => onWire(point,w));
    return wire < 0 ? null : {kind:'wires',index:wire};
  }

  function fit() {
    const all = points();
    const [minX,minY] = all.reduce(([x,y],p) => [Math.min(x,p[0]),Math.min(y,p[1])], [Infinity,Infinity]);
    const [maxX,maxY] = all.reduce(([x,y],p) => [Math.max(x,p[0]),Math.max(y,p[1])], [-Infinity,-Infinity]);
    const {width,height} = canvas.getBoundingClientRect();
    scale = all.length ? Math.max(4, Math.min(36, width/(maxX-minX+6), height/(maxY-minY+6))) : 22;
    origin = all.length ? [(width-(minX+maxX)*scale)/2,(height-(minY+maxY)*scale)/2] : [width/2,height/2];
    draw();
  }
  function reset(){
    const {width,height}=canvas.getBoundingClientRect();
    scale=22;
    origin=[width/2,height/2];
    draw();
  }

  function draw() {
    if (!state.project) return;
    const {ctx,width,height} = canvasContext(canvas);
    const [gridInk, wireInk, selectionInk, symbolInk, markerInk, cursorInk] =
      palette(canvas, 'dot', 'wire', 'selected', 'symbol', 'marker', 'crosshair');
    const line = (a,b) => {ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.stroke();};
    const dot = (p,r) => {ctx.beginPath();ctx.arc(...p,r,0,2*Math.PI);ctx.fill();};
    ctx.fillStyle = gridInk;
    for (let x = origin[0]%scale; x < width; x += scale)
      for (let y = origin[1]%scale; y < height; y += scale) dot([x,y], .9);
    const selected = (kind,i) => state.selection[kind].includes(i);
    const {parts,wires,junctions,markers} = state.project;
    ctx.lineWidth = 2;
    wires.forEach(([a,b],i) => {ctx.strokeStyle = selected('wires',i) ? selectionInk : wireInk;line(xy(a),xy(b));});
    const anchors = new Map(points().map(p => [String(p),p]));
    for (const p of anchors.values()) {
      const explicit = junctions.findIndex(q => same(p,q));
      const connections = wires.reduce((count,w) => count + (onWire(p,w) ? w.some(q => same(p,q)) ? 1 : 2 : 0),0);
      const terminals = state.pins.flat().filter(q => same(p,q)).length;
      if (explicit >= 0 || connections + terminals > 2) {
        ctx.fillStyle = selected('junctions',explicit) ? selectionInk : wireInk;
        dot(xy(p),4);
      }
    }
    parts.forEach((part,i) => {
      const color = selected('parts',i) ? selectionInk : symbolInk;
      ctx.save();
      ctx.translate(...xy([part.x,part.y]));
      ctx.scale(scale,scale);
      ctx.rotate(part.rotation*Math.PI/2);
      ctx.strokeStyle = ctx.fillStyle = color;
      ctx.lineWidth = 2/scale;
      drawSymbol(ctx,part,state.pins[i],line);
      ctx.restore();
      ctx.fillStyle = color;
      ctx.font = '12px system-ui';
      const [x,y] = xy([part.x,part.y]);
      const label = part.kind === 'G' ? '' : part.kind === 'N' ? part.value : part.ref + '  ' + part.value;
      const vertical = part.rotation % 2 && !'GNXQMJS'.includes(part.kind);
      ctx.fillText(label,x+(vertical ? 12 : 5),y+(vertical ? 0 : -scale*.85));
      ctx.fillStyle = color;
      state.pins[i].forEach(p => dot(xy(p),2.8));
    });
    if ($('show-markers').checked) markers.forEach((marker,i) => {
      const pins = marker.kind === 'I'
        ? [state.pins[parts.findIndex(p=>p.ref.toUpperCase()===marker.ref.toUpperCase())]?.[marker.pin]].filter(Boolean)
        : marker.points;
      ctx.fillStyle = markerInk;
      ctx.font = 'bold 12px system-ui';
      pins.forEach((p,j) => {const [x,y]=xy(p);dot([x,y],5);ctx.fillText(marker.kind+(i+1)+(marker.kind==='VD' ? j ? '−' : '+' : ''),x+7,y-6);});
    });
    if (cursor && state.tool !== 'select') {
      const [x,y] = xy(cursor);
      ctx.strokeStyle = cursorInk;
      ctx.setLineDash([4,4]);
      line([x-7,y],[x+7,y]);line([x,y-7],[x,y+7]);
      if (state.tool === 'wire' && state.anchor) route(state.anchor,cursor).forEach(([a,b])=>line(xy(a),xy(b)));
      ctx.setLineDash([]);
    }
    if (gesture?.box && gesture.last) {
      const [x,y]=gesture.pixel,[u,v]=gesture.last;
      ctx.fillStyle='#93edd124';ctx.fillRect(x,y,u-x,v-y);
      ctx.strokeStyle=wireInk;ctx.strokeRect(x,y,u-x,v-y);
    }
  }

  canvas.onpointerdown = event => {
    if (![0,1,2].includes(event.button)) return;
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    const pixel=local(event), point=grid(pixel);
    gesture={pixel,point,pan:event.button!==0 || event.altKey,extend:event.shiftKey};
    if (gesture.pan) {gesture.origin=origin.slice();return;}
    if (state.tool !== 'select') {callbacks.use(point,hit(point,pixel));return;}
    const item=hit(point,pixel);
    if (item) {
      if (event.shiftKey || !state.selection[item.kind].includes(item.index)) callbacks.select(item,event.shiftKey);
      gesture.move=!event.shiftKey;
    } else {
      if (!event.shiftKey) callbacks.select(null,false);
      gesture.box=true;
    }
  };
  canvas.onpointermove = event => {
    const pixel=local(event);
    if (gesture?.pan) origin=gesture.origin.map((v,i)=>v+pixel[i]-gesture.pixel[i]);
    if (gesture) gesture.last=pixel;
    cursor=grid(pixel);
    $('coordinates').textContent=cursor.join(', ');
    draw();
  };
  canvas.onpointerup = event => {
    const current=gesture;
    gesture=null;
    if (!current || current.pan || !current.last) return draw();
    const point=grid(local(event));
    if (current.move && !same(current.point,point)) callbacks.move(point.map((v,i)=>v-current.point[i]));
    if (current.box && distance(current.pixel,current.last)>5) callbacks.box(current.point,point,current.extend);
    draw();
  };
  canvas.onpointercancel=()=>{gesture=null;draw();};
  canvas.onpointerleave=()=>{cursor=null;draw();};
  canvas.oncontextmenu=event=>event.preventDefault();
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const p=local(event), old=scale;
    scale=Math.max(4,Math.min(95,scale*Math.exp(-event.deltaY*.001)));
    origin=origin.map((v,i)=>p[i]+(v-p[i])*scale/old);
    draw();
  },{passive:false});
  new ResizeObserver(draw).observe(canvas);
  return {draw,fit,reset};
}

function drawSymbol(ctx, part, pins, line) {
  const poly = points => {ctx.beginPath();ctx.moveTo(...points[0]);points.slice(1).forEach(p=>ctx.lineTo(...p));ctx.stroke();};
  const circle = radius => {ctx.beginPath();ctx.arc(0,0,radius,0,2*Math.PI);ctx.stroke();};
  const h = (a,b) => line([a,0],[b,0]);
  switch (part.kind) {
    case 'G':
      poly([[0,0],[0,.5],[-.5,.5],[.5,.5]]);
      line([-.32,.7],[.32,.7]);line([-.15,.9],[.15,.9]);return;
    case 'N':
      poly([[0,0],[.35,-.4],[1,-.4]]);return;
    case 'R':
      poly([[-2,0],[-1,0],[-.8,-.32],[-.52,.32],[-.26,-.32],[0,.32],[.26,-.32],[.52,.32],[.8,-.32],[1,0],[2,0]]);return;
    case 'C':
      h(-2,-.24);h(.24,2);line([-.24,-.66],[-.24,.66]);line([.24,-.66],[.24,.66]);return;
    case 'L':
      h(-2,-1);h(1,2);
      for(let i=0;i<4;i++){ctx.beginPath();ctx.arc(-.75+i*.5,0,.25,Math.PI,2*Math.PI);ctx.stroke();}return;
    case 'D':
      h(-2,-.55);h(.55,2);poly([[-.55,-.55],[.55,0],[-.55,.55],[-.55,-.55]]);line([.55,-.55],[.55,.55]);return;
    case 'V': case 'I':
      h(-2,-.72);h(.72,2);circle(.72);
      if(part.kind==='V'){line([-.53,0],[-.22,0]);line([-.375,-.15],[-.375,.15]);line([.22,0],[.53,0]);}
      else{h(-.4,.35);poly([[.08,-.22],[.35,0],[.08,.22]]);}return;
  }
  if (!part.legacy_pin_layout && 'QMJ'.includes(part.kind)) {
    poly([[1,-2],[1,-.75],[.3,-.35]]);poly([[1,2],[1,.75],[.3,.35]]);
    line([.3,-.7],[.3,.7]);poly([[-2,0],[-.1,0]]);
    if(part.kind==='Q') line([-.1,0],[.3,0]);
    else line([-.1,-.55],[-.1,.55]);
    if(pins.length===4) poly([[3,0],[.72,0],[.48,-.17],[.48,.17],[.72,0]]);
    return;
  }
  if (!part.legacy_pin_layout && part.kind==='S') {
    poly([[-2,-1],[-.7,-1],[.6,-1.65]]);line([.7,-1],[2,-1]);
    line([-1,2],[-1,.45]);line([1,2],[1,.45]);line([-1,.45],[1,.45]);return;
  }
  const halfHeight=Math.max(1,Math.ceil(pins.length/2));
  ctx.strokeRect(-1.75,-halfHeight,3.5,halfHeight*2);
  const split=Math.ceil(pins.length/2);
  part.port_names.forEach((name,i)=>{
    const left=i<split, y=left ? 2*i-split+1 : 2*(i-split)-(pins.length-split)+1;
    hPin(left,y,name);
  });
  function hPin(left,y,name) {
    line([left?-3:3,y],[left?-1.75:1.75,y]);
    ctx.font='.45px system-ui';
    ctx.textAlign=left?'left':'right';
    ctx.fillText(name,left?-1.55:1.55,y+.15);
  }
}

