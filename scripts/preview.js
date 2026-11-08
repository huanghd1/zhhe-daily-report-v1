// 本地预览：用 node:http 提供 public/ 目录，模拟 GitHub Pages。
// 直接双击打开 HTML（file://）时浏览器会拦截 fetch('./data.json')，所以需要起一个本地服务。
// 只监听 127.0.0.1，只读 public/ 下的文件，不对局域网开放。
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // GitHub Pages 会按扩展名给这两个类型，本地预览也保持一致
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// URL 路径 → public/ 下的文件；越界（../ 或编码后的 %2e%2e、%5c）或不存在时返回 null。
// 与 Pages 一致：/ 和 /fortune 分别对应 index.html 和 fortune.html
function resolveFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const candidates = extname(rel) ? [rel] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const candidate of candidates) {
    const file = join(PUBLIC_DIR, candidate);
    if (!file.startsWith(PUBLIC_DIR + sep)) return null;
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // 不存在，试下一个
    }
  }
  return null;
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const file = resolveFile(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地预览：http://127.0.0.1:${PORT}/  （赛博求签：/fortune）`);
});
