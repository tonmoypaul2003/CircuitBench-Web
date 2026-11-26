import {$, button, canvasContext, download, element, field, options, palette} from './utils.js';

const traceColors = node => palette(node, 'trace-1', 'trace-2', 'trace-3', 'trace-4', 'trace-5', 'trace-6');
const fmt = value => Number.isFinite(value) ? Number(value.toPrecision(6)).toString() : '—';
const valueOf = (pair, mode) => {
  if (!pair) return NaN;
  const [real, imag] = pair, magnitude = Math.hypot(real, imag);
  if (mode === 'dB') return 20 * Math.log10(magnitude);
  if (mode === 'Phase') return Math.atan2(imag, real)*180/Math.PI;
  return mode === 'Magnitude' ? magnitude : real;
};

export function createPlots(call, report) {
  let plot, pages=[], active=0;
  const tabs=$('pages'), list=$('plots');
  const newPanel=()=>({
    title:'', xLabel:'', yLabel:'', mode:isAC()?'Magnitude':'Real', height:300,
    grid:6, background:null, colors:{}, pins:[], limits:['','','',''],
    signals:new Set(plot.selected.length ? plot.selected : plot.names.flatMap((name,i)=>i===0 && hasScale() ? [] : name.startsWith('v(') ? [i] : [])),
  });
  const axis=()=>plot.names[0]?.toLowerCase();
  const isAC=()=>axis()==='frequency';
  const hasScale=()=>plot.rows.length>1 && ['frequency','time','v(v-sweep)','i(i-sweep)','v-sweep','i-sweep','temp-sweep'].includes(axis());
  function show(data) {
    plot=data;
    active=0;
    pages=plot ? [{name:plot.title,panels:[newPanel()]}] : [];
    render();
  }

  function render() {
    tabs.replaceChildren();list.replaceChildren();
    $('add-page').disabled=$('add-plot').disabled=!plot;
    if (!plot) {
      element('p','Run a simulation or open an ASCII ngspice waveform.',list).className='empty';
      return;
    }
    pages.forEach((page,i)=>{
      const tab=button(page.name,tabs,()=>{active=i;render();});
      tab.setAttribute('aria-pressed',String(i===active));
    });
    const page=pages[active];
    button('Rename page',tabs,()=>{
      const name=window.prompt('Page name',page.name)?.trim();
      if(name){page.name=name;render();}
    });
    button('Remove page',tabs,()=>{
      if(pages.length>1){pages.splice(active,1);active=Math.max(0,active-1);render();}
    }).disabled=pages.length<2;
    button('Duplicate page',tabs,()=>{
      pages.push({...structuredClone(page),name:page.name+' copy'});active=pages.length-1;render();
    });
    button('Page PNG',tabs,()=>{
      const canvases=[...list.querySelectorAll('canvas')];
      const combined=element('canvas');
      combined.width=Math.max(...canvases.map(canvas=>canvas.width));
      combined.height=canvases.reduce((height,canvas)=>height+canvas.height,0);
      const ctx=combined.getContext('2d');
      let top=0;
      for(const canvas of canvases){ctx.drawImage(canvas,0,top);top+=canvas.height;}
      savePng(combined,'plot-page.png');
    });
    button('Print page / PDF',tabs,()=>window.print());
    page.panels.forEach((config,i)=>mount(config,i,page));
  }

  function mount(config,index,page) {
    const panel=element('article',null,list);panel.className='plot';
    const bar=element('div',null,panel);bar.className='toolbar';
    element('h2',config.title||'Plot '+(index+1),bar);
    const mode=element('select',null,bar);mode.setAttribute('aria-label','Trace display');
    options(mode,['Real','Magnitude','dB','Phase'].map(x=>[x,x]),config.mode);
    const canvas=element('canvas',null,panel);
    canvas.setAttribute('aria-label','Simulation waveform');canvas.style.height=config.height+'px';
    const readout=element('output','Click the graph to inspect a sample.',panel);
    let cursor=null, coordinates;
    const draw=()=>{
      coordinates=drawPlot(canvas,plot,config,hasScale(),isAC(),cursor);
      readout.textContent=cursor ? cursor.label : 'Click the graph to inspect a sample.';
    };
    mode.onchange=()=>{config.mode=mode.value;cursor=null;draw();};
    button('CSV',bar,()=>{
      const columns=[...new Set([...(hasScale()?[0]:[]),...config.signals])];
      const data=[columns.flatMap(i=>[plot.names[i]+' real',plot.names[i]+' imaginary']).map(x=>'"'+x.replaceAll('"','""')+'"').join(','),
        ...plot.rows.map(row=>columns.flatMap(i=>row[i]||['','']).join(','))];
      download('waveform.csv',data.join('\n'),'text/csv');
    });
    button('PNG',bar,()=>savePng(canvas,'plot.png'));
    button('Print subplot / PDF',bar,()=>{
      panel.classList.add('print-selected');
      list.classList.add('print-one');
      window.addEventListener('afterprint',()=>{
        panel.classList.remove('print-selected');list.classList.remove('print-one');
      },{once:true});
      window.print();
    });
    button('Pin cursor',bar,()=>{if(cursor){config.pins.push(cursor);draw();}});
    button('Clear pins',bar,()=>{config.pins=[];draw();});
    button('Remove subplot',bar,()=>{page.panels.splice(index,1);render();}).disabled=page.panels.length<2;
    const detail=element('details',null,panel);element('summary','Traces, labels and axes',detail);
    const colors=traceColors(panel);
    const traces=element('div',null,detail);traces.className='traces';
    plot.names.forEach((name,i)=>{
      if(hasScale()&&i===0)return;
      const label=element('label',null,traces);
      const toggle=element('input',null,label);toggle.type='checkbox';toggle.checked=config.signals.has(i);
      label.append(name);
      const color=element('input',null,label);color.type='color';color.value=config.colors[i]||colors[i%colors.length];
      color.setAttribute('aria-label',name+' color');
      toggle.onchange=()=>{if(toggle.checked)config.signals.add(i);else config.signals.delete(i);draw();};
      color.oninput=()=>{config.colors[i]=color.value;draw();};
    });
    const settings=element('div',null,detail);settings.className='toolbar';
    for(const [key,title] of [['title','Title'],['xLabel','X label'],['yLabel','Y label'],['height','Height'],['grid','Grid divisions'],['background','Background']]){
      const type=key==='background'?'color':['height','grid'].includes(key)?'number':'text';
      const input=field(settings,title,config[key] ?? palette(panel,'sheet')[0],type);
      input.onchange=()=>{
        config[key]=key==='height'?Math.max(160,Math.min(1000,Number(input.value))) :
          key==='grid'?Math.max(0,Math.min(20,Number(input.value))):input.value;
        if(key==='title') bar.querySelector('h2').textContent=config.title||'Plot '+(index+1);
        canvas.style.height=config.height+'px';draw();
      };
    }
    ['X min','X max','Y min','Y max'].forEach((label,i)=>{
      const input=field(settings,label,config.limits[i],'number');input.step='any';
      input.onchange=()=>{config.limits[i]=input.value;draw();};
    });
    const pinSettings=element('div',null,detail);pinSettings.className='toolbar';
    const pinTrace=element('select',null,element('label','Trace for pin',pinSettings));
    const pinX=field(pinSettings,'Pin X coordinate','','number');pinX.step='any';
    const pinLabel=field(pinSettings,'Pin label','');
    const listTraces=()=>options(pinTrace,[...config.signals].map(i=>[String(i),plot.names[i]]),pinTrace.value||null);
    traces.addEventListener('change',listTraces);
    listTraces();
    button('Pin by X',pinSettings,()=>{
      if(pinTrace.value===''||pinX.value==='')return report('Select a visible trace and enter the X coordinate.');
      const pin=coordinates?.pin(Number(pinX.value),Number(pinTrace.value),pinLabel.value.trim());
      if(pin){config.pins.push(pin);draw();}
    });
    const expressions=element('div',null,detail);expressions.className='toolbar';
    const expression=field(expressions,'Derived trace','','text');
    expression.placeholder='gain = db(v(out) / v(in))';
    const evaluate=async()=>{
      const match=expression.value.match(/^\s*([^=]+?)\s*=\s*(.+)$/);
      const name=match ? match[1] : expression.value.trim();
      if(!name)return;
      const source=plot;
      if(source.names.some(item=>item.toLowerCase()===name.toLowerCase()))return report('Use a unique trace name.');
      try{
        const samples=await call('expression',{plot:source,expression:match?match[2]:name});
        if(plot!==source)return;
        config.signals.add(plot.names.length);plot.names.push(name);plot.units.push('');
        plot.rows.forEach((row,i)=>row.push(samples[i]));render();
        list.querySelectorAll('details')[index].open=true;
      }catch(error){report(error.message);}
    };
    button('Add trace',expressions,evaluate);
    expression.onkeydown=event=>{if(event.key==='Enter')evaluate();};
    function inspect(event){
      cursor=coordinates?.sample(event.offsetX,event.offsetY);
      draw();
    }
    canvas.onpointerdown=event=>{if(event.button===0){canvas.setPointerCapture(event.pointerId);inspect(event);}};
    canvas.onpointermove=event=>{if(event.buttons===1)inspect(event);};
    canvas.oncontextmenu=event=>{event.preventDefault();cursor=null;draw();};
    draw();
    // Resize listeners are removed when this panel is replaced.
    const observer=new ResizeObserver(()=>{
      if(panel.isConnected)draw();else observer.disconnect();
    });
    observer.observe(canvas);
  }

  $('add-page').onclick=()=>{if(plot){pages.push({name:'Page '+(pages.length+1),panels:[newPanel()]});active=pages.length-1;render();}};
  $('add-plot').onclick=()=>{if(plot){pages[active].panels.push(newPanel());render();}};
  show(null);
  return {show,refreshTheme:render};
}

function savePng(canvas,name) {
  canvas.toBlob(blob=>{if(blob)download(name,blob);});
}

function drawPlot(canvas,plot,config,scaled,logX,cursor) {
  const {ctx,width,height}=canvasContext(canvas);
  const frames=[72,24,width-24,height-52], [left,top,right,bottom]=frames;
  if(right<=left || bottom<=top)return;
  const colors=traceColors(canvas);
  const [background, ink, gridInk, markerInk]=palette(canvas,'sheet','text','grid-ink','crosshair');
  ctx.fillStyle=config.background || background;ctx.fillRect(0,0,width,height);
  const projectX=x=>logX?Math.log10(x):x;
  const xAt=i=>scaled?plot.rows[i][0]?.[0]:i;
  const columns=[...config.signals];
  const sampleValue=(i,k)=>valueOf(plot.rows[i][k],config.mode);
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  plot.rows.forEach((row,i)=>{
    const x=projectX(xAt(i));
    if(Number.isFinite(x)){minX=Math.min(minX,x);maxX=Math.max(maxX,x);}
    for(const k of columns){
      const y=sampleValue(i,k);
      if(Number.isFinite(y)){minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
  });
  if(!Number.isFinite(minX)){minX=0;maxX=1;}
  if(!Number.isFinite(minY)){minY=0;maxY=1;}
  if(minX===maxX){minX-=.5;maxX+=.5;}
  if(minY===maxY){const padding=Math.abs(minY)*.1||1;minY-=padding;maxY+=padding;}
  const [xmin,xmax,ymin,ymax]=config.limits.map((v,i)=>v===''?NaN:i<2?projectX(Number(v)):Number(v));
  if ((Number.isFinite(xmin)?xmin:minX)<(Number.isFinite(xmax)?xmax:maxX)){
    if(Number.isFinite(xmin))minX=xmin;if(Number.isFinite(xmax))maxX=xmax;
  }
  if ((Number.isFinite(ymin)?ymin:minY)<(Number.isFinite(ymax)?ymax:maxY)){
    if(Number.isFinite(ymin))minY=ymin;if(Number.isFinite(ymax))maxY=ymax;
  }
  const xPixel=x=>left+(projectX(x)-minX)/(maxX-minX)*(right-left);
  const yPixel=y=>bottom-(y-minY)/(maxY-minY)*(bottom-top);
  const line=(a,b,c,d)=>{ctx.beginPath();ctx.moveTo(a,b);ctx.lineTo(c,d);ctx.stroke();};
  ctx.font='12px system-ui';
  for(let i=0;i<=Math.max(1,config.grid);i++){
    const f=i/Math.max(1,config.grid), x=left+(right-left)*f, y=bottom-(bottom-top)*f;
    ctx.strokeStyle=gridInk;ctx.fillStyle=ink;
    if(config.grid){line(x,top,x,bottom);line(left,y,right,y);}
    ctx.textAlign='center';
    const value=minX+f*(maxX-minX);ctx.fillText(fmt(logX?10**value:value),x,bottom+17);
    ctx.textAlign='right';ctx.fillText(fmt(minY+f*(maxY-minY)),left-7,y+4);
  }
  ctx.textAlign='center';
  ctx.fillText(config.xLabel||(scaled?plot.names[0]:'Sample'),(left+right)/2,height-9);
  if(config.title)ctx.fillText(config.title,(left+right)/2,15);
  ctx.save();ctx.translate(13,(top+bottom)/2);ctx.rotate(-Math.PI/2);
  ctx.fillText(config.yLabel||config.mode,0,0);ctx.restore();
  ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
  for(const k of columns){
    let joined=false;
    ctx.strokeStyle=ctx.fillStyle=config.colors[k]||colors[k%colors.length];ctx.lineWidth=1.75;ctx.beginPath();
    plot.rows.forEach((row,i)=>{
      const x=xPixel(xAt(i)),y=yPixel(sampleValue(i,k));
      if(!Number.isFinite(x+y)){joined=false;return;}
      if(plot.rows.length===1){ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();}
      else if(joined)ctx.lineTo(x,y);
      else ctx.moveTo(x,y);
      joined=true;
    });ctx.stroke();
  }
  for(const mark of [...config.pins,...(cursor?[cursor]:[])]){
    const x=xPixel(xAt(mark.index)),y=yPixel(sampleValue(mark.index,mark.trace));
    if(!Number.isFinite(x+y))continue;
    ctx.fillStyle=markerInk;ctx.strokeStyle=markerInk;ctx.lineWidth=1;
    line(x,top,x,bottom);
    ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();
    ctx.textAlign=x>right-160?'right':'left';ctx.fillText(mark.label,x+(x>right-160?-7:7),Math.max(top+14,y-9));
  }
  ctx.restore();
  const makePin=(index,trace,label)=>({index,trace,label:label||
    plot.names[trace]+' = '+fmt(sampleValue(index,trace))+' at '+fmt(xAt(index))});
  return {sample(x,y){
    let best,score=Infinity;
    plot.rows.forEach((row,index)=>{
      const p=xPixel(xAt(index));
      if(Math.abs(p-x)>score) return;
      for(const trace of columns){
        const value=sampleValue(index,trace), distance=Math.hypot(p-x,yPixel(value)-y);
        if(distance<score){best=makePin(index,trace);score=distance;}
      }
    });
    return best;
  },pin(x,trace,label){
    let best,score=Infinity;
    plot.rows.forEach((row,index)=>{
      const distance=Math.abs(xAt(index)-x);
      if(distance<score && Number.isFinite(sampleValue(index,trace))){
        best=makePin(index,trace,label);score=distance;
      }
    });
    return best;
  }};
}

