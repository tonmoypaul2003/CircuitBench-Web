import {loadPyodide} from './vendor/pyodide/pyodide.mjs';

const sources = ['circuit', 'spice_library', 'qucs_library', 'results', 'plot_math', 'bridge'];
const ready = (async () => {
  const [python, files] = await Promise.all([
    loadPyodide({indexURL: new URL('./vendor/pyodide/', import.meta.url).href}),
    Promise.all(sources.map(async name => {
      const response = await fetch(new URL('./core/' + name + '.py', import.meta.url));
      if (!response.ok) throw new Error('Could not load ' + name);
      return response.text();
    })),
  ]);
  python.FS.mkdir('/circuitbench');
  sources.forEach((name, i) => python.FS.writeFile('/circuitbench/' + name + '.py', files[i]));
  python.runPython("import sys\nsys.path.insert(0, '/circuitbench')\nfrom bridge import dispatch");
  return python.globals.get('dispatch');
})();

self.onmessage = async ({data: {id, payload}}) => {
  try {
    const dispatch = await ready;
    self.postMessage({id, value: JSON.parse(dispatch(JSON.stringify(payload)))});
  } catch (error) {
    self.postMessage({id, error: error.message.trim().split('\n').at(-1)});
  }
};
