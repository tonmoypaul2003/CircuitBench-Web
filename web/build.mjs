import {cp, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
const copy = (origin, target = origin) => cp(join(root, origin), join(dist, target), {recursive: true});
const core = ['circuit', 'spice_library', 'qucs_library', 'results', 'plot_math'];
const python = ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

await mkdir(dist, {recursive: true});
await Promise.all([
  ...['index.html', 'style.css', 'app.js', 'sheet.js', 'plots.js', 'engine.js', 'core-worker.js', 'sim-worker.js', 'utils.js'].map(name => copy(name)),
  ...core.map(name => copy('../' + name + '.py', 'core/' + name + '.py')),
  copy('bridge.py', 'core/bridge.py'),
  copy('../runtime/CircuitBench.ico', 'CircuitBench.ico'),
  copy('../runtime/models', 'models'),
  copy('NOTICES.md', 'notices/README.md'),
  copy('../LICENSE', 'notices/CircuitBench-LICENSE'),
  ...python.map(name => copy('node_modules/pyodide/' + name, 'vendor/pyodide/' + name)),
  ...['ngspice.js', 'COPYING', 'LICENSE'].map(name => copy('node_modules/@o.z/ngspice-wasm/' + name, 'vendor/ngspice/' + name)),
  writeFile(join(dist, '.nojekyll'), ''),
]);

