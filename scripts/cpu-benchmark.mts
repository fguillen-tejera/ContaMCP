import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { stagingLogin } from './staging-auth.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/cpu-benchmark.mts HTTPS_STAGING_MCP RUN_LABEL [--public-only]\nThree rounds of 20 requests/operation. Read-only, paced MCP traffic; credentials stay in memory. Correlate X-ContaMCP-Benchmark with sanitized wrangler tail CPU events.',
  );
  process.exit(0);
}
const endpoint = new URL(args[0] ?? 'https://staging.invalid/mcp');
const label = args[1] ?? '';
if (
  endpoint.protocol !== 'https:' ||
  endpoint.pathname !== '/mcp' ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.username ||
  endpoint.password ||
  endpoint.hostname.endsWith('.invalid') ||
  !/^[a-z0-9-]{1,40}$/.test(label)
)
  throw new Error('Supply approved staging /mcp URL and a nonfinancial run label.');
let sequence = 0;
let operation = 'oauth';
let round = 0;
const request: typeof fetch = async (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const key = `${label}:${round}:${operation}:${++sequence}`;
  headers.set('X-ContaMCP-Benchmark', key);
  const response = await fetch(input, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  console.log(
    JSON.stringify({
      sample: key,
      time: new Date().toISOString(),
      status: response.status,
      colo: response.headers.get('cf-ray')?.split('-').at(-1),
      requestId: response.headers.get('x-request-id'),
    }),
  );
  return response;
};
const client = new Client({ name: 'contamcp-cpu-benchmark', version: '1' });
try {
  if (!args.includes('--public-only')) {
    const grant = await stagingLogin(endpoint, 'benchmark account A', 'expenses:read', request);
    operation = 'initialize';
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: request,
        requestInit: { headers: { Authorization: `Bearer ${grant.access_token}` } },
      }),
    );
  }
  const cases = [
    {
      name: 'health',
      run: async () => {
        const r = await request(new URL('/health', endpoint));
        await r.body?.cancel();
        return r.status;
      },
    },
    {
      name: 'discovery',
      run: async () => {
        const r = await request(new URL('/.well-known/oauth-protected-resource/mcp', endpoint));
        await r.body?.cancel();
        return r.status;
      },
    },
    ...(args.includes('--public-only')
      ? []
      : [
          {
            name: 'tools-list',
            run: async () => {
              await client.listTools();
              return 200;
            },
          },
          {
            name: 'summary',
            run: async () => {
              const r = await client.callTool({
                name: 'get_expense_summary',
                arguments: { from: '2099-12-29', to: '2099-12-29' },
              });
              if (r.isError) throw new Error('Summary failed');
              return 200;
            },
          },
        ]),
  ];
  for (round = 1; round <= 3; round++) {
    for (const test of cases) {
      operation = test.name;
      console.log(JSON.stringify({ phase: operation, round, start: new Date().toISOString() }));
      for (let i = 0; i < 20; i++) {
        if ((await test.run()) !== 200) throw new Error('Unexpected benchmark status');
        await delay(550);
      }
      console.log(JSON.stringify({ phase: operation, round, end: new Date().toISOString() }));
    }
  }
  console.log(JSON.stringify({ complete: true, label }));
} catch {
  console.error('FAIL: CPU benchmark incomplete. No credentials or response contents logged.');
  process.exitCode = 1;
} finally {
  await client.close();
}
