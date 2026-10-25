import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const assets = new Map<string, readonly [string, string]>([
  ...['privacy', 'privacidad', 'support', 'soporte'].map(
    (name) => [`/${name}`, [`${name}.html`, 'text/html; charset=utf-8']] as const,
  ),
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/es', ['index.html', 'text/html; charset=utf-8']],
  ['/es/', ['index.html', 'text/html; charset=utf-8']],
  ['/en', ['english.html', 'text/html; charset=utf-8']],
  ['/en/', ['english.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/main.js', ['main.js', 'text/javascript; charset=utf-8']],
  ['/locale.js', ['locale.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/openai-blossom-white.png', ['openai-blossom-white.png', 'image/png']],
]);

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const asset = assets.get(pathname);
  if (!asset || (request.method !== 'GET' && request.method !== 'HEAD')) {
    response.writeHead(404).end('Not found');
    return;
  }

  try {
    const contents = await readFile(new URL(`../website/${asset[0]}`, import.meta.url));
    response.writeHead(200, {
      'Content-Type': asset[1] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  } catch {
    response.writeHead(500).end('Unable to read website asset');
  }
});

server.listen(4321, '127.0.0.1', () => {
  console.info('ContaMCP website → http://localhost:4321');
});
