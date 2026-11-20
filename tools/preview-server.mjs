/**
 * Tiny static server for visually previewing the dashboard with mocked Chrome APIs.
 * Run: node tools/preview-server.mjs
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function letterFor(host) {
  const letter = (host.replace(/^www\./, '')[0] || '?').toUpperCase();
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) hash = host.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 72% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 28) % 360} 70% 48%)"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="42" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="34" font-weight="700" fill="white">${letter}</text></svg>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === '/mock-favicon.svg') {
      const pageUrl = url.searchParams.get('pageUrl') || 'example.com';
      let host = pageUrl;
      try {
        host = new URL(pageUrl).hostname;
      } catch {
        /* keep raw */
      }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(letterFor(host));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/preview' || url.pathname === '/preview.html') {
      let html = await readFile(join(ROOT, 'dashboard/dashboard.html'), 'utf8');
      html = html.replace('<head>', '<head>\n    <base href="/dashboard/" />');
      html = html.replace(
        '<script type="module" src="dashboard.js"></script>',
        '<script src="/tools/mock-chrome.js"></script>\n    <script src="/tools/preview-auto.js"></script>\n    <script type="module" src="dashboard.js"></script>',
      );
      if (url.searchParams.get('still') === '1') {
        html = html.replace('</head>', '<style>*{animation:none !important;transition:none !important}</style></head>');
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    if (url.pathname === '/popup' || url.pathname === '/popup.html') {
      let html = await readFile(join(ROOT, 'popup/popup.html'), 'utf8');
      html = html.replace('<head>', '<head>\n    <base href="/popup/" />');
      html = html.replace(
        '<script type="module" src="popup.js"></script>',
        '<script src="/tools/mock-chrome.js"></script>\n    <script src="/tools/preview-auto.js"></script>\n    <script type="module" src="popup.js"></script>',
      );
      if (url.searchParams.get('still') === '1') {
        html = html.replace('</head>', '<style>*{animation:none !important;transition:none !important}</style></head>');
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end(html);
      return;
    }

    const pathname = decodeURIComponent(url.pathname);
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    console.error(error);
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`TabStash preview: http://localhost:${PORT}/preview`);
});
