import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { URL, fileURLToPath } from 'node:url';
import { z } from 'zod';

const source = new URL('../plugins/contamcp/', import.meta.url);
const manifest = z
  .object({ name: z.literal('contamcp'), version: z.string().regex(/^\d+\.\d+\.\d+$/) })
  .parse(JSON.parse(await readFile(new URL('plugin.json', source), 'utf8')));
const files = ['plugin.json', 'mcp.json', 'assets/icon.svg'];
const sourcePath = await realpath(source);
for (const file of files) {
  const expectedPath = fileURLToPath(new URL(file, source));
  if ((await realpath(expectedPath)) !== expectedPath)
    throw new Error(`Plugin packaging does not accept symlinks: ${file}`);
}

const output = new URL('../dist/plugins/', import.meta.url);
await mkdir(output, { recursive: true });
const archive = fileURLToPath(new URL(`${manifest.name}-${manifest.version}.zip`, output));
await rm(archive, { force: true });
// An explicit file list keeps local credentials, deployment settings and review evidence out.
execFileSync('zip', ['-X', '-q', archive, ...files], { cwd: sourcePath, stdio: 'pipe' });
console.info(`Prepared ${archive}`);
