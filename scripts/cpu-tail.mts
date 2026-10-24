import { spawn } from 'node:child_process';
import { z } from 'zod';

const sampleSchema = z.object({
  eventTimestamp: z.number(),
  cpuTime: z.number(),
  wallTime: z.number(),
  outcome: z.string(),
  scriptVersion: z.object({ id: z.string() }).optional(),
  event: z.object({
    request: z.object({
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()),
    }),
    response: z.object({ status: z.number() }).optional(),
  }),
});
const child = spawn('pnpm', ['exec', 'wrangler', 'tail', '--env', 'staging', '--format', 'json'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let buffer = '';
let start = -1;
let depth = 0;
let quoted = false;
let escaped = false;
child.stdout.on('data', (chunk: Buffer) => {
  for (const c of chunk.toString()) {
    if (start < 0) {
      if (c !== '{') continue;
      start = 0;
      buffer = '';
      depth = 0;
    }
    buffer += c;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const parsed = sampleSchema.safeParse(JSON.parse(buffer));
        if (parsed.success) {
          const e = parsed.data;
          const tag = Object.entries(e.event.request.headers).find(
            ([k]) => k.toLowerCase() === 'x-contamcp-benchmark',
          )?.[1];
          if (tag && /^[a-z0-9:-]{1,100}$/.test(tag))
            console.log(
              JSON.stringify({
                sample: tag,
                time: e.eventTimestamp,
                cpuMs: e.cpuTime,
                wallMs: e.wallTime,
                outcome: e.outcome,
                status: e.event.response?.status,
                method: e.event.request.method,
                path: new URL(e.event.request.url).pathname,
                version: e.scriptVersion?.id,
              }),
            );
        }
      } catch {}
      start = -1;
      buffer = '';
    }
  }
});
child.stderr.on('data', () => {});
let stopping = false;
const stop = () => {
  stopping = true;
  child.kill('SIGTERM');
};
child.on('exit', (code) => {
  if (!stopping && code !== 0) console.error('FAIL: CPU tail exited before completion.');
  process.exitCode = stopping ? 0 : (code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, stop);
setTimeout(stop, 25 * 60 * 1000).unref();
