import { readFile } from 'node:fs/promises';
import { z } from 'zod';
const requestSchema = z.object({ sample: z.string(), status: z.number() });
const cpuSchema = z.object({ sample: z.string(), cpuMs: z.number(), outcome: z.string() });
const lines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
const requests = (await lines(process.argv[2] ?? '')).flatMap((x) => {
  const r = requestSchema.safeParse(x);
  return r.success ? [r.data] : [];
});
const cpu = (await lines(process.argv[3] ?? '')).flatMap((x) => {
  const r = cpuSchema.safeParse(x);
  return r.success ? [r.data] : [];
});
const byTag = new Map(cpu.map((x) => [x.sample, x]));
for (const [operation, rows] of Map.groupBy(requests, (x) => x.sample.split(':')[2])) {
  if (!['health', 'discovery', 'tools-list', 'summary'].includes(operation ?? '')) continue;
  const samples = rows.flatMap((r) => {
    const e = byTag.get(r.sample);
    return e ? [e] : [];
  });
  const values = samples.map((x) => x.cpuMs).sort((a, b) => a - b);
  const quantile = (p: number, min: number) =>
    values.length >= min ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
  console.log(
    JSON.stringify({
      operation,
      sent: rows.length,
      delivered: values.length,
      coverage: values.length / rows.length,
      p50: quantile(0.5, 1),
      p95: quantile(0.95, 20),
      p99: quantile(0.99, 100),
      max: values.at(-1) ?? null,
      above10: values.filter((x) => x > 10).length,
      exceededCpu: samples.filter((x) => x.outcome === 'exceededCpu').length,
      httpFailures: rows.filter((x) => x.status !== 200).length,
      firstDelivered: samples[0]?.cpuMs,
    }),
  );
}
