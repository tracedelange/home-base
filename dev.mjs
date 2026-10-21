// Dev server: serves dist/, rebuilds when src/ or content/ change, and reloads open pages
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';

const PORT = 4000;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const reload = '<script>new EventSource("/__reload").onmessage = () => location.reload()</script>';
const clients = new Set();

const build = () => {
  try { execFileSync('node', ['build.mjs'], { stdio: 'inherit' }); return true; }
  catch { return false; }  // the build printed its error; keep serving the last good dist/
};
build();

createServer(async (req, res) => {
  if (req.url === '/__reload') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path.endsWith('/')) path += 'index.html';
  try {
    let body = await readFile(join('dist', path));
    if (extname(path) === '.html') body = body.toString().replace('</body>', `${reload}</body>`);
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

// Editors often write a file in several steps, so wait for changes to settle before rebuilding
let timer;
for (const dir of ['src', 'content']) watch(dir, { recursive: true }, () => {
  clearTimeout(timer);
  timer = setTimeout(() => { if (build()) for (const c of clients) c.write('data: reload\n\n'); }, 100);
});
