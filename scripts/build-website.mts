import { copyFile, mkdir, rm } from 'node:fs/promises';
import { URL } from 'node:url';

const outputDirectory = new URL('../dist/website/', import.meta.url);
const assets = [
  'privacy.html',
  'privacidad.html',
  'support.html',
  'soporte.html',
  'index.html',
  'english.html',
  'styles.css',
  'main.js',
  'locale.js',
  'favicon.svg',
  'openai-blossom-white.png',
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
for (const asset of assets) {
  await copyFile(new URL(`../website/${asset}`, import.meta.url), new URL(asset, outputDirectory));
}
console.info(`Prepared ${assets.length} public website assets in dist/website.`);
