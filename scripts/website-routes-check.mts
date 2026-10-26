import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { websiteServer } from './website.mts';

let origin: string;
before(async () => {
  websiteServer.listen(0, '127.0.0.1');
  await once(websiteServer, 'listening');
  const address = websiteServer.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});
after(
  () =>
    new Promise<void>((resolve, reject) => {
      websiteServer.close((error) => (error ? reject(error) : resolve()));
    }),
);

for (const [path, policies] of [
  ['/en', ['/privacy', '/terms', '/support']],
  ['/es', ['/privacidad', '/terminos', '/soporte']],
] as const) {
  test(`${path} connects to ChatGPT and serves its linked policies and assets`, async () => {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200);
    const html = await response.text();
    const actions = html.match(/<div class="final-cta-actions">([\s\S]*?)<\/div>/)?.[1] ?? '';
    assert.equal(actions.match(/href="([^"]+)"/)?.[1], 'https://chatgpt.com/plugins');

    const footer = html.slice(html.indexOf('<footer'));
    const links = [...footer.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((link) => link[1]);
    const pages = [html];
    for (const policy of policies) {
      assert.ok(links.includes(policy), `Missing footer link: ${policy}`);
      const page = await fetch(new URL(policy, origin));
      assert.equal(page.status, 200, policy);
      assert.match(page.headers.get('Content-Type') ?? '', /^text\/html/);
      pages.push(await page.text());
    }

    const assets = new Set(
      pages.flatMap((page) =>
        [...page.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)].map((asset) => asset[1] ?? ''),
      ),
    );
    for (const asset of assets) {
      const result = await fetch(new URL(asset, origin));
      assert.equal(result.status, 200, asset);
      assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff', asset);
      await result.arrayBuffer();
    }
  });
}

test('the preview supports HEAD and denies private paths and writes', async () => {
  const head = await fetch(new URL('/en', origin), { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of [
    '/package.json',
    '/wrangler.jsonc',
    '/.dev.vars.production',
    '/src/index.ts',
  ]) {
    const result = await fetch(new URL(path, origin));
    assert.equal(result.status, 404, path);
    await result.text();
  }
  const write = await fetch(new URL('/en', origin), { method: 'POST', body: 'synthetic draft' });
  assert.equal(write.status, 404);
  await write.text();
});
