import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loadPyodide} from './dist/vendor/pyodide/pyodide.mjs';
import {simulate} from './dist/engine.js';

const python=await loadPyodide({indexURL:fileURLToPath(new URL('./dist/vendor/pyodide/',import.meta.url))});
python.FS.mkdir('/circuitbench');
for(const name of ['bridge','circuit','plot_math','qucs_library','results','spice_library']){
  python.FS.writeFile('/circuitbench/'+name+'.py',await readFile(new URL('./dist/core/'+name+'.py',import.meta.url)));
}
python.runPython("import sys\nsys.path.insert(0, '/circuitbench')\nfrom bridge import dispatch");
const dispatch=python.globals.get('dispatch');
const call=(op,args={})=>JSON.parse(dispatch(JSON.stringify({op,...args})));
const close=(actual,expected,tolerance)=>assert.ok(Math.abs(actual-expected)<=tolerance,actual+' differs from '+expected);
async function solve(project,annotate=false){
  const {input,measurements,operating_point}=call('netlist',{project,annotate});
  const {raw,log,error}=await simulate(input);
  assert.ok(!error,log);
  assert.match(raw,/Command: ngspice-46/);
  return call('waveform',{raw,measurements,operating_point});
}
function signal(plot,name){
  const index=plot.names.indexOf(name);
  assert.ok(index>=0,name+' missing from '+plot.names.join(', '));
  return plot.rows.map(row=>row[index]);
}

const {project:divider}=call('init');
divider.markers=[
  {kind:'V',points:[[5,-2]]},
  {kind:'VD',points:[[-6,-2],[5,-2]]},
  {kind:'I',ref:'R2',pin:0},
];
const op=await solve(divider);
close(signal(op,'v(out)')[0][0],5,1e-10);
assert.equal(op.selected.length,3);
close(op.rows[0][op.selected[1]][0],5,1e-10);
close(op.rows[0][op.selected[2]][0],.005,1e-10);
close(call('expression',{plot:op,expression:'multiply(v(out), 2)'})[0][0],10,1e-10);

const bias=await solve(divider,true);
const output=bias.annotations.nodes.find(node=>node.net==='out');
assert.deepEqual(output.point,[5,-2]);
close(output.value,5,1e-10);
assert.equal(bias.annotations.nodes.find(node=>node.net==='0').value,0);
assert.equal(bias.annotations.currents.length,3);
for(const {part,pin,value} of bias.annotations.currents){
  assert.equal(pin,0);
  close(value,divider.parts[part].ref==='V1'?-.005:.005,1e-10);
}
assert.equal(bias.selected.length,3);
assert.ok(!bias.names.some(name=>/^[vi]\([nv]_cwb/.test(name)));

const ac=await solve(call('example',{name:'ac'}).project);
const frequencies=signal(ac,'frequency');
const near=frequencies.findIndex(([value])=>value>=159);
close(Math.hypot(...signal(ac,'v(out)')[near]),Math.SQRT1_2,.02);

const tran=await solve(call('example',{name:'transient'}).project);
const times=signal(tran,'time');
const timeIndex=times.findIndex(([value])=>value>=.001);
close(signal(tran,'v(out)')[timeIndex][0],1-Math.exp(-1),.01);

const sweep=call('profile',{project:divider,edit:'new',name:'Source sweep',mode:'DC'}).project;
const dc=await solve(sweep,true);
assert.equal(dc.rows.length,11);
assert.equal(dc.annotations,null);
close(signal(dc,'v(out)').at(-1)[0],5,1e-10);

const upgraded=call('validate',{project:{...divider,version:1}}).project;
assert.equal(upgraded.version,2);
const {project:blank}=call('example',{name:'blank'});
assert.throws(()=>call('netlist',{project:blank}),/ground reference/);

const text=await readFile(new URL('./dist/models/qucs-diodes.lib',import.meta.url),'utf8');
const {catalog}=call('import',{project:blank,files:[{name:'diodes.lib',text}]});
assert.ok(catalog.length>20);
const placed=call('place',{project:blank,entry:{kind:'D',qucs:catalog[0]},point:[0,0]});
assert.ok(placed.project.parts[0].value in placed.project.qucs_models);

const starterPath='./dist/models/basic_models/OpAmps/generic_opamp.lib';
const starter=await readFile(new URL(starterPath,import.meta.url),'utf8');
const imported=call('import',{project:blank,files:[{name:'generic_opamp.lib',text:starter}]});
assert.equal(imported.count,1);
const [model]=Object.keys(imported.project.subcircuits);
const subcircuit=call('place',{project:imported.project,entry:{kind:'X',value:model},point:[5,2]});
assert.deepEqual(subcircuit.project.parts[0].port_names,imported.project.subcircuits[model].ports);

const diode=call('init').project;
Object.assign(diode.parts[2],{kind:'D',ref:'D1',value:'DDEFAULT'});
const forward=await solve(diode);
assert.ok(signal(forward,'v(out)')[0][0]>.5 && signal(forward,'v(out)')[0][0]<.8);
console.log('ngspice WASM and Pyodide verified for OP, AC, transient, DC sweep, diode, markers, project files and model import.');
dispatch.destroy();
