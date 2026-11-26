import createNgspice from './vendor/ngspice/ngspice.js';

export async function simulate(input) {
  const lines = [];
  const capture = line => { if (lines.length < 2000) lines.push(line); };
  const engine = await createNgspice({noInitialRun: true, print: capture, printErr: capture, stdin: () => null});
  const {FS} = engine;
  // ngspice's Linux memory estimator reads this file. Keep the budget inside the WASM heap.
  FS.writeFile('/proc/meminfo', 'MemTotal: 262144 kB\nMemFree: 196608 kB\nMemAvailable: 196608 kB\n');
  FS.writeFile('/circuit.cir', input);
  const args = ['ngspice', '-n', '-b', '/circuit.cir'];
  const argv = engine.stackAlloc((args.length + 1) * 4);
  args.forEach((arg, index) => {
    const pointer = engine.stackAlloc(arg.length + 1);
    engine.stringToUTF8(arg, pointer, arg.length + 1);
    engine.setValue(argv + index * 4, pointer, 'i32');
  });
  engine.setValue(argv + args.length * 4, 0, 'i32');
  let code;
  try {
    code = engine._main(args.length, argv);
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    code = error.status;
  }
  const log = lines.join('\n');
  if (code || !FS.analyzePath('/result.raw').exists) {
    return {log, error: 'ngspice did not produce a waveform.'};
  }
  return {log, raw: FS.readFile('/result.raw', {encoding: 'utf8'})};
}
