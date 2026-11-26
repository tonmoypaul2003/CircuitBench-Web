import {$, button, download, element, engineering, field, options} from './utils.js';
import {createSheet, route, onWire} from './sheet.js';
import {createPlots} from './plots.js';

const worker = new Worker(new URL('./core-worker.js',import.meta.url),{type:'module'});
const requests = new Map();
let sequence = 0;
let workerFailure;
worker.onmessage = ({data:{id,value,error}}) => {
  const request=requests.get(id);
  if(!request)return;
  requests.delete(id);
  if(error)request.reject(new Error(error));else request.resolve(value);
};
worker.onerror=event=>{
  workerFailure=new Error(event.message || 'Could not start the browser runtime.');
  requests.forEach(request=>request.reject(workerFailure));
  requests.clear();
};
const emptySelection=()=>({parts:[],wires:[],junctions:[]});
const state={tool:'select',anchor:null,selection:emptySelection(),catalog:[]};
const undo=[],redo=[];
let editing=false, runWorker, generation=0, currentRun, projectName='CircuitBench.cwb', savedProject='';
const dirty=()=>state.project && JSON.stringify(state.project)!==savedProject;
const report=message=>{$('status').textContent=message;};
const call=(op,payload={})=>new Promise((resolve,reject)=>{
  if(workerFailure){reject(workerFailure);return;}
  const id=++sequence;
  requests.set(id,{resolve,reject});
  worker.postMessage({id,payload:{op,...payload}});
});
const sheet=createSheet(state,{use,move,select,box});
const plots=createPlots(call,report);
const systemTheme=matchMedia('(prefers-color-scheme: dark)');
function applyTheme(){
  document.documentElement.dataset.theme=$('theme').value==='system'
    ? systemTheme.matches?'dark':'light'
    : $('theme').value;
  sheet.draw();
  plots.refreshTheme();
}
$('theme').value=document.documentElement.dataset.theme || 'system';
$('theme').onchange=()=>{
  try{localStorage.setItem('circuitbench-theme',$('theme').value);}catch{}
  applyTheme();
};
systemTheme.addEventListener('change',applyTheme);
applyTheme();

function show(next) {
  state.project=next.project;
  state.pins=next.pins;
  refresh();
}
function remember() {
  undo.push({project:state.project,pins:state.pins});
  if(undo.length>80)undo.shift();
  redo.length=0;
}
async function change(op, fields={}, candidate=state.project, after=()=>{}) {
  if(editing || !state.project)return;
  editing=true;
  try {
    const response=await call(op,{...fields,project:candidate});
    remember();
    after(response);
    show(response);
    return response;
  } catch(error) {report(error.message);}
  finally{editing=false;}
}
function mutate(edit,after) {
  const project=structuredClone(state.project);
  edit(project);
  return change('validate',{},project,after);
}
function restore(from,to) {
  if(!from.length||editing)return;
  to.push({project:state.project,pins:state.pins});
  state.selection=emptySelection();
  setTool('select');
  show(from.pop());
}
function replace(next,name='CircuitBench.cwb') {
  projectName=name;
  savedProject=JSON.stringify(next.project);
  undo.length=redo.length=0;
  state.selection=emptySelection();
  setTool('select');
  show(next);
  sheet.fit();
}
function select(item,extend) {
  if(!extend)state.selection=emptySelection();
  if(item){
    const indices=state.selection[item.kind];
    const position=indices.indexOf(item.index);
    if(position<0)indices.push(item.index);else if(extend)indices.splice(position,1);
  }
  refreshSelection();
  sheet.draw();
}
function box(a,b,extend) {
  if(!extend)state.selection=emptySelection();
  const contains=p=>p.every((v,i)=>v>=Math.min(a[i],b[i])&&v<=Math.max(a[i],b[i]));
  const {parts,wires,junctions}=state.project;
  const groups={
    parts:parts.map(part=>[[part.x,part.y]]),
    wires,junctions:junctions.map(point=>[point]),
  };
  for(const [kind,items] of Object.entries(groups)){
    const indices=items.flatMap((points,i)=>points.every(contains)?[i]:[]);
    state.selection[kind]=[...new Set([...state.selection[kind],...indices])];
  }
  refreshSelection();sheet.draw();
}
function move(delta){
  if(Object.values(state.selection).some(indices=>indices.length))
    change('move',{selection:Object.values(state.selection),delta});
}
function setTool(tool,entry) {
  state.tool=tool;state.anchor=null;state.entry=entry;
  for(const control of $('tools').querySelectorAll('[data-tool]'))control.setAttribute('aria-pressed',String(control.dataset.tool===tool));
  hints();sheet.draw();
}
function hints(){
  const hints={
    select:'Drag to select. Shift adds to selection. Scroll to zoom. Middle-drag pans.',
    wire:state.anchor?'Click the wire endpoint.':'Click the wire start.',
    junction:'Click a wire to add a junction.',
    place:'Click to place '+(state.entry?.label||'component')+'. Esc selects.',
    V:'Click a wire or pin.', VD:state.anchor?'Click the negative node.':'Click the positive node.',
    I:'Click a device pin to measure current into it.',
  };
  $('hint').textContent=hints[state.tool];
}
function use(point,hit) {
  if(editing)return;
  if(state.tool==='place'){
    change('place',{entry:state.entry,point},state.project,response=>{
      state.selection={...emptySelection(),parts:[response.project.parts.length-1]};
    });return;
  }
  if(state.tool==='wire'){
    if(!state.anchor)state.anchor=point;
    else{
      const segments=route(state.anchor,point);
      if(segments.length)mutate(project=>{
        for(const segment of segments){
          if(!project.wires.some(wire=>wire.every(p=>segment.some(q=>String(p)===String(q)))))project.wires.push(segment);
        }
      });
      state.anchor=null;
    }
  }
  if(state.tool==='junction' && state.project.wires.some(w=>onWire(point,w)) &&
      !state.project.junctions.some(p=>String(p)===String(point))){
    mutate(project=>project.junctions.push(point));
  }
  if(state.tool==='I' && hit?.pin!=null){
    const part=state.project.parts[hit.index];
    if(!'GN'.includes(part.kind))mutate(project=>project.markers.push({kind:'I',ref:part.ref,pin:hit.pin}));
  }
  if(['V','VD'].includes(state.tool)){
    const target=hit?.pin!=null?state.pins[hit.index][hit.pin]:point;
    if(!state.pins.flat().some(p=>String(p)===String(target)) &&
        !state.project.wires.some(w=>onWire(target,w)))return report('Choose a pin or wire.');
    if(state.tool==='VD' && !state.anchor) state.anchor=target;
    else {
      const marker={kind:state.tool,points:state.anchor?[state.anchor,target]:[target]};
      mutate(project=>project.markers.push(marker));
      state.anchor=null;
    }
  }
  hints();sheet.draw();
}

function refresh(){
  options($('profile'),Object.keys(state.project.profiles).map(name=>[name,name]),state.project.active);
  $('remove-profile').disabled=Object.keys(state.project.profiles).length<=1;
  $('undo').disabled=undo.length===0;$('redo').disabled=redo.length===0;
  populateLibrary();refreshSelection();refreshMarkers();refreshBias();sheet.draw();
}
function refreshBias(){
  state.bias = currentRun?.annotations && JSON.stringify(currentRun.project)===JSON.stringify(state.project)
    ? currentRun.annotations : null;
  $('bias-controls').hidden=!state.bias;
  const readings=$('bias-readings');
  readings.replaceChildren();
  if(!state.bias)return;
  for(const {net,value} of state.bias.nodes){
    element('dt',net==='0'?'Ground':net,readings);
    element('dd',engineering(value,'V'),readings);
  }
  for(const {part,pin,value} of state.bias.currents){
    const device=state.project.parts[part];
    const terminal=device.port_names[pin] || 'pin '+(pin+1);
    element('dt',device.ref+' · '+terminal,readings);
    element('dd',engineering(Math.abs(value),'A')+(value===0?'':value>0?' into':' out of'),readings);
  }
}
function updatePlotVisibility(){
  const visible=$('plot-control').hidden || $('show-plot').checked;
  for(const id of ['pages','plots','add-page','add-plot'])$(id).hidden=!visible;
}
function showResult(display,mode){
  plots.show(display);
  $('plot-control').hidden=!display||!['OP','DC'].includes(mode);
  $('show-plot').checked=false;
  updatePlotVisibility();
  refreshBias();
  sheet.draw();
}
function refreshMarkers(){
  const panel=$('markers');panel.replaceChildren();
  state.project.markers.forEach((marker,i)=>{
    const row=element('div',null,panel);row.className='marker-row';
    element('span',marker.kind==='I'?'I('+marker.ref+':'+(marker.pin+1)+')':
      marker.kind+' '+marker.points.map(p=>p.join(',')).join(' / '),row);
    const remove=button('Remove',row,()=>mutate(project=>project.markers.splice(i,1)));
    remove.setAttribute('aria-label','Remove marker '+(i+1));
  });
  if(state.project.markers.length)button('Clear markers',panel,()=>mutate(project=>{project.markers=[];}));
}
function populateLibrary(){
  const list=$('parts');list.replaceChildren();
  const {device_models,diode_models,qucs_models,subcircuits}=state.project;
  const entries=Object.entries(state.parts).filter(([kind])=>!'XQMJS'.includes(kind))
    .map(([kind,[label]])=>({kind,label}));
  for(const kind of 'VI'){
    for(const [name,source] of Object.entries(state.sources)){
      entries.push({kind,label:kind+(name==='AC'?'phase':name.toLowerCase()),value:source.replace(/^DC 5$/,kind==='I'?'DC 1m':'DC 5')});
    }
  }
  for(const [value,model] of Object.entries(device_models)){
    const [kind]=state.ports[model.type];
    entries.push({kind,label:value,value});
  }
  Object.keys({...diode_models,...qucs_models}).forEach(value=>entries.push({kind:'D',label:value,value}));
  Object.keys(subcircuits).forEach(value=>entries.push({kind:'X',label:value,value}));
  state.catalog.forEach(qucs=>entries.push({kind:'D',label:qucs.name,qucs}));
  const query=$('search').value.trim().toLowerCase();
  const matches=entries.filter(entry=>(entry.label+' '+entry.kind+' '+(entry.qucs?.description||'')).toLowerCase().includes(query));
  matches.slice(0,240).forEach(entry=>{
    const control=button('',list,()=>setTool('place',entry));
    element('small',entry.kind,control);control.append(entry.label);
  });
  if(matches.length>240)element('p','Search to see more models.',list).className='empty';
}
function refreshSelection(){
  const panel=$('properties');panel.replaceChildren();
  const count=Object.values(state.selection).flat().length;
  const index=state.selection.parts[0];
  $('rotate').disabled=count!==1||index==null;
  $('delete').disabled=!count;
  if(count!==1||index==null){
    element('p',count?count+' selected':'Select a component to edit its properties.',panel).className='empty';
    return;
  }
  const item=state.project.parts[index];
  const ref=field(panel,'Reference',item.ref);
  const value=field(panel,item.kind==='N'?'Net name':'Value or model',item.value);
  if(item.kind==='G')value.disabled=true;
  button('Apply',panel,()=>apply(ref.value,value.value));
  if('VI'.includes(item.kind))button('Source parameters',panel,()=>sourceDialog(item,value.value,ref.value,apply));
  if(item.kind==='D')button('Diode model',panel,()=>diodeDialog(item));
  function apply(nextRef,nextValue){
    change('edit_part',{index,ref:nextRef,value:nextValue});
  }
}
function deleteSelection(){
  if(!Object.values(state.selection).flat().length)return;
  mutate(project=>{
    const removed=new Set(state.selection.parts.map(i=>project.parts[i].ref.toUpperCase()));
    for(const [kind,indices] of Object.entries(state.selection)){
      project[kind]=project[kind].filter((_,index)=>!indices.includes(index));
    }
    project.markers=project.markers.filter(marker=>marker.kind!=='I'||!removed.has(marker.ref.toUpperCase()));
  },()=>{state.selection=emptySelection();});
}
function rotate(){
  if(!$('rotate').disabled)change('rotate',{index:state.selection.parts[0]});
}
function dialog(title,build,onApply) {
  const box=$('dialog'),body=$('dialog-body'),apply=$('dialog-apply');
  $('dialog-title').textContent=title;
  body.replaceChildren();
  build(body);
  apply.hidden=!onApply;
  box.querySelector('form').onsubmit=event=>{
    if(event.submitter?.value!=='apply')return;
    event.preventDefault();
    if(!box.querySelector('form').reportValidity())return;
    box.close();
    onApply?.();
  };
  box.showModal();
}
const profileFields={
  OP:[],AC:[['start_hz','Start frequency'],['stop_hz','Stop frequency'],['points','Points per decade']],
  TRAN:[['step','Time step'],['stop','Stop time']],
  DC:[['sweep_source','Source reference'],['sweep_start','Start'],['sweep_stop','Stop'],['sweep_step','Step']],
};
function modeSelect(panel,value){
  const select=element('select',null,element('label','Analysis type',panel));
  options(select,[['OP','Operating point'],['AC','AC sweep'],['TRAN','Transient'],['DC','DC source sweep']],value);
  return select;
}
function profileDialog(edit){
  const profile=structuredClone(state.project.profiles[state.project.active]);
  let mode,name,inputs;
  dialog(edit==='update'?'Profile settings':edit==='duplicate'?'Duplicate profile':'New simulation profile',panel=>{
    if(edit!=='update')name=field(panel,'Name',edit==='duplicate'?state.project.active+' copy':'');
    if(edit==='duplicate')return;
    mode=modeSelect(panel,edit==='update'?profile.mode:'OP');
    if(edit!=='update')return;
    const values=element('div',null,panel);
    const render=()=>{
      values.replaceChildren();
      inputs=profileFields[mode.value].map(([key,label])=>[key,field(values,label,profile[key],key==='points'?'number':'text')]);
    };
    mode.onchange=render;render();
  },()=>{
    if(edit==='update'){
      const values=Object.fromEntries(inputs.map(([key,input])=>[key,key==='points'?Number(input.value):input.value.trim()]));
      change('profile',{edit,fields:{...profile,...values,mode:mode.value}});
    }else change('profile',{edit,name:name.value,mode:mode?.value||profile.mode});
  });
}
function diodeDialog(part){
  let name,current,emission;
  const model=state.project.diode_models[part.value.toUpperCase()];
  dialog('Diode model',panel=>{
    name=field(panel,'Model name',model?part.value.toUpperCase():'CUSTOM_DIODE');
    current=field(panel,'Saturation current (IS)',model?.[0]||'1e-14');
    emission=field(panel,'Emission coefficient (N)',model?.[1]||'1');
  },()=>{
    const key=name.value.trim().toUpperCase();
    if(Object.hasOwn(state.project.device_models,key) || Object.hasOwn(state.project.qucs_models,key)){
      report('That model name is already in use.');return;
    }
    mutate(project=>{
      project.diode_models[key]=[current.value.trim(),emission.value.trim()];
      project.parts.find(item=>item.ref===part.ref).value=key;
    });
  });
}
function sourceDialog(part,value,ref,apply){
  const waveFields={
    SIN:['Offset','Amplitude','Frequency','Delay','Damping','Phase'],
    PULSE:['Low','High','Delay','Rise','Fall','Width','Period'],
    EXP:['Initial','Pulsed','Rise delay','Rise time constant','Fall delay','Fall time constant'],
    PWL:['Time/value pairs'],
  };
  let dc,ac,phase,wave,inputs;
  const tokens=value.replace(/[(),]/g,' ').trim().split(/\s+/);
  const index=key=>tokens.findIndex(token=>token.toUpperCase()===key);
  const waveName=Object.keys(waveFields).find(key=>index(key)>=0)||'None';
  dialog('Source parameters · '+part.ref,panel=>{
    dc=field(panel,'DC bias',index('DC')>=0?tokens[index('DC')+1]:/^[+\-.\d]/.test(tokens[0])?tokens[0]:'');
    ac=field(panel,'AC magnitude',index('AC')>=0?tokens[index('AC')+1]:'');
    phase=field(panel,'AC phase',index('AC')>=0 && /^[+\-.\d]/.test(tokens[index('AC')+2]||'')?tokens[index('AC')+2]:'');
    wave=element('select',null,element('label','Transient waveform',panel));
    options(wave,['None',...Object.keys(waveFields)].map(x=>[x,x]),waveName);
    const section=element('div',null,panel);
    const render=()=>{
      section.replaceChildren();
      const existing=wave.value===waveName?tokens.slice(index(waveName)+1).filter((_,i,values)=>{
        const cutoff=values.findIndex(token=>/^(DC|AC)$/i.test(token));
        return cutoff<0||i<cutoff;
      }):state.sources[wave.value]?.split(' ').slice(1)||[];
      inputs=(waveFields[wave.value]||[]).map((name,i)=>field(section,name,wave.value==='PWL'?existing.join(' '):existing[i]||''));
    };
    wave.onchange=render;render();
  },()=>{
    const parts=[];
    if(dc.value.trim())parts.push('DC',dc.value.trim());
    if(ac.value.trim())parts.push('AC',ac.value.trim(),phase.value.trim()||'0');
    if(wave.value!=='None')parts.push(wave.value,...inputs.map(input=>input.value.trim()).filter(Boolean));
    apply(ref,parts.join(' '));
  });
}
function showNetlist(){
  call('netlist',{project:state.project}).then(({deck})=>dialog('SPICE netlist',panel=>{
    element('pre',deck,panel);button('Download netlist',panel,()=>download('circuit.cir',deck));
  })).catch(error=>report(error.message));
}

const starterModels=['bipolar/BC546.lib','bipolar/BC556.lib','JFet/2SJ74.mod','JFet/2SK170.mod',
  'MOS power/IRFP240_NVDMOS.mod','MOS power/IRFP9240_PVDMOS.mod','OpAmps/generic_opamp.lib','OpAmps/Op07.mod'];
async function bundled(paths){
  const files=await Promise.all(paths.map(async name=>{
    const response=await fetch(new URL('./models/'+name,import.meta.url));
    if(!response.ok)throw new Error('Could not load '+name);
    return {name,text:await response.text()};
  }));
  await importModels(files);
}
async function importModels(files){
  const response=await change('import',{files},state.project,result=>{
    const merged=new Map(state.catalog.map(item=>[JSON.stringify(item),item]));
    result.catalog.forEach(item=>merged.set(JSON.stringify(item),item));
    result.newCatalog=merged.size-state.catalog.length;
    state.catalog=[...merged.values()];
  });
  if(response){
    report('Imported '+(response.count+response.newCatalog)+' definitions.');
    if(response.issues.length)dialog('Model import diagnostics',panel=>element('pre',response.issues.join('\n'),panel));
  }
}

let db;
const runCache=new Map();
async function database(){
  if(!db)db=new Promise((resolve,reject)=>{
    const request=indexedDB.open('circuitbench-runs',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('runs',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  return db;
}
async function storedRuns(write){
  const connection=await database();
  return new Promise((resolve,reject)=>{
    const tx=connection.transaction('runs',write?'readwrite':'readonly');
    const store=tx.objectStore('runs');
    if(write)store.put(write);
    const request=store.getAll();
    tx.oncomplete=()=>resolve(request.result);
    tx.onabort=()=>reject(tx.error);
  });
}
async function refreshHistory(write){
  if(write)runCache.set(write.id,write);
  try{
    const records=await storedRuns(write);
    records.forEach(record=>runCache.set(record.id,record));
  }catch{
    if(write)report('Run available in this tab. Browser storage is unavailable.');
  }
  const records=[...runCache.values()].sort((a,b)=>b.date-a.date);
  options($('history'),[['','Run history'],...records.map(run=>
    [run.id,new Date(run.date).toLocaleString()+' · '+run.name+' · '+run.status])],currentRun?.id||'');
}
function runControls(active){
  $('run').disabled=active;
  $('cancel').hidden=!active;
}
async function acceptRun(record,isCurrent=()=>true){
  const display=record.raw?await call('waveform',{raw:record.raw,measurements:record.measurements,
    operating_point:record.operating_point}):null;
  if(!isCurrent())return;
  currentRun=record;
  currentRun.annotations=display?.annotations;
  showResult(display,record.mode || (display?.title==='Operating Point'?'OP':undefined));
  $('logs').disabled=false;
}
async function run(){
  if($('run').disabled || !state.project)return;
  const id=++generation;
  const project=structuredClone(state.project);
  const record={id:crypto.randomUUID(),date:Date.now(),name:project.active,project,
    status:'Failed',raw:null,log:''};
  const start=performance.now();
  runControls(true);
  report('Compiling schematic…');
  try{
    Object.assign(record,await call('netlist',{project,annotate:true}));
    if(id!==generation)return;
    report('Running ngspice in this browser…');
    const response=await new Promise((resolve,reject)=>{
      const sim=new Worker(new URL('./sim-worker.js',import.meta.url),{type:'module'});
      runWorker={sim,reject};
      sim.onmessage=event=>resolve(event.data);
      sim.onerror=event=>reject(new Error(event.message||'Could not load ngspice.'));
      sim.postMessage(record.input);
    });
    if(id!==generation)return;
    record.log=response.log||'';
    if(response.error)throw new Error(response.error);
    record.raw=response.raw;
    await acceptRun(record,()=>id===generation);
    if(id!==generation)return;
    record.status='Completed';
    report('Simulation completed in '+((performance.now()-start)/1000).toFixed(2)+' s.'
      +(record.mode==='OP' && state.bias?' Voltage and current are shown on the schematic.':''));
    await refreshHistory(record);
  }catch(error){
    if(id!==generation)return;
    record.error=error.message;
    record.raw=null;
    currentRun=record;
    $('logs').disabled=false;
    showResult(null);
    report(error.message);
    await refreshHistory(record);
  }finally{
    if(id===generation){
      runWorker?.sim.terminate();
      runWorker=null;
      runControls(false);
    }
  }
}
function cancel(){
  generation++;
  runWorker?.sim.terminate();
  runWorker?.reject(new Error('Simulation canceled.'));
  runWorker=null;
  runControls(false);
  report('Simulation canceled.');
}
function filesDialog(){
  if(!currentRun)return;
  const run=currentRun;
  dialog('Run files · '+run.name,panel=>{
    element('pre',[run.error,run.log].filter(Boolean).join('\n')||'No simulator log available.',panel);
    for(const [name,contents] of [['run.log',run.log],['schematic.cwb',run.project&&JSON.stringify(run.project,null,2)],
      ['circuit.cir',run.deck],['solver-input.cir',run.input],['result.raw',run.raw]]){
      if(contents)button('Download '+name,panel,()=>download(name,contents));
    }
  });
}

$('tools').querySelectorAll('[data-tool]').forEach(control=>control.onclick=()=>setTool(control.dataset.tool));
$('search').oninput=populateLibrary;
$('search').onkeydown=event=>{if(event.key==='Enter')$('parts').querySelector('button')?.click();};
$('show-markers').onchange=sheet.draw;
$('show-bias').onchange=sheet.draw;
$('show-plot').onchange=updatePlotVisibility;
$('fit').onclick=sheet.fit;
$('reset-view').onclick=sheet.reset;
$('ground').onclick=()=>setTool('place',{kind:'G',label:'Ground'});
$('label').onclick=()=>setTool('place',{kind:'N',label:'Net label'});
$('rotate').onclick=rotate;
$('delete').onclick=deleteSelection;
$('undo').onclick=()=>restore(undo,redo);
$('redo').onclick=()=>restore(redo,undo);
$('profile').onchange=()=>mutate(project=>{project.active=$('profile').value;});
$('edit-profile').onclick=()=>profileDialog('update');
$('new-profile').onclick=()=>profileDialog('new');
$('duplicate-profile').onclick=()=>profileDialog('duplicate');
$('remove-profile').onclick=()=>change('profile',{edit:'remove'});
$('netlist').onclick=showNetlist;
$('open').onclick=()=> $('project-file').click();
function save(){
  if(!state.project)return;
  download(projectName,JSON.stringify(state.project,null,2),'application/json');
  savedProject=JSON.stringify(state.project);
}
$('save').onclick=save;
$('save-as').onclick=()=>{
  const name=window.prompt('Schematic filename',projectName)?.trim();
  if(!name)return;
  projectName=/\.cwb$/i.test(name)?name:name+'.cwb';
  save();
};
$('project-file').onchange=async event=>{
  const file=event.target.files[0];
  event.target.value='';
  if(!file || editing || (dirty() && !window.confirm('Discard unsaved schematic changes?')))return;
  editing=true;
  try{replace(await call('validate',{project:JSON.parse(await file.text())}),file.name);report('Opened '+file.name);}
  catch(error){report(error.message);}
  finally{editing=false;}
};
async function loadExample(name){
  if(!name || editing || (dirty() && !window.confirm('Discard unsaved schematic changes?')))return;
  editing=true;
  try{replace(await call('example',{name}));}
  catch(error){report(error.message);}
  finally{editing=false;}
}
$('example').onchange=event=>{
  const name=event.target.value;
  event.target.value='';
  loadExample(name);
};
$('models').onclick=()=>$('model-files').click();
$('model-files').onchange=async event=>{
  const files=[...event.target.files];
  event.target.value='';
  try{if(files.length)await importModels(await Promise.all(files.map(async file=>({name:file.name,text:await file.text()}))));}
  catch(error){report(error.message);}
};
$('starter').onclick=()=>bundled(starterModels.map(name=>'basic_models/'+name)).catch(error=>report(error.message));
$('qucs').onclick=()=>bundled(['qucs-diodes.lib']).catch(error=>report(error.message));
$('run').onclick=run;
$('cancel').onclick=cancel;
$('logs').onclick=filesDialog;
$('open-raw').onclick=()=>$('raw-file').click();
$('raw-file').onchange=async event=>{
  const file=event.target.files[0];
  event.target.value='';
  if(!file)return;
  try{await acceptRun({name:file.name,raw:await file.text(),measurements:[]});$('history').value='';}
  catch(error){report(error.message);}
};
$('history').onchange=async event=>{
  const record=runCache.get(event.target.value);
  if(record)try{await acceptRun(record);}catch(error){report(error.message);}
};
document.addEventListener('keydown',event=>{
  if(!state.project || $('dialog').open)return;
  const key=event.key.toLowerCase();
  if(key==='f5'){event.preventDefault();run();return;}
  if(event.ctrlKey||event.metaKey){
    const commands={
      o:()=>$('open').click(),s:()=>$(event.shiftKey?'save-as':'save').click(),
      n:()=>loadExample('blank'),
      m:()=>setTool('V'),
    };
    if(commands[key]){event.preventDefault();commands[key]();return;}
  }
  if(event.target.matches?.('input,select,textarea,button'))return;
  if(event.ctrlKey||event.metaKey){
    if(key==='z'){event.preventDefault();if(event.shiftKey)restore(redo,undo);else restore(undo,redo);}
    if(key==='y'){event.preventDefault();restore(redo,undo);}
    return;
  }
  const actions={escape:()=>setTool('select'),w:()=>setTool('wire'),j:()=>setTool('junction'),
    p:()=>$('search').focus(),f:sheet.fit,r:rotate,delete:deleteSelection,
    arrowup:()=>move([0,-1]),arrowdown:()=>move([0,1]),arrowleft:()=>move([-1,0]),arrowright:()=>move([1,0])};
  if(actions[key]){event.preventDefault();actions[key]();}
});
window.addEventListener('beforeunload',event=>{
  if(dirty()){event.preventDefault();event.returnValue='';}
});

for(const control of document.querySelectorAll('header button,header select'))control.disabled=true;
$('logs').disabled=true;
call('init').then(initial=>{
  Object.assign(state,{parts:initial.parts,sources:initial.sources,ports:initial.ports});
  document.querySelector('main').inert=false;
  document.querySelector('main').removeAttribute('aria-busy');
  for(const control of document.querySelectorAll('header button,header select'))control.disabled=false;
  replace(initial);
  report('Ready · ngspice 46 WebAssembly');
  refreshHistory();
}).catch(error=>report('CircuitBench could not start. '+error.message));
