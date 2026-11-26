import {spawn} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('./dist', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

await stat(resolve(root, 'index.html')).catch(() => {
  throw new Error('Build the app first with npm run build.');
});

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405).end();
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Port 8765 is already in use. If CircuitBench is already open, use its existing window.'
    : error.message);
  process.exitCode = 1;
});
server.listen(8765, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  console.log('CircuitBench is running at ' + url);
  console.log('Keep this window open while using the app. Press Ctrl+C to stop.');
  if (process.platform === 'win32' && process.argv.includes('--open')) {
    const open = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {windowsHide: true, stdio: 'ignore'});
    open.on('error', () => console.log('Open the address above in your browser.'));
  }
});
