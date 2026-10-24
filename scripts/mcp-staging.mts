import { runCorrectionGuardProbes } from './correction-guard-probes.ts';
import { stagingLogin } from './staging-auth.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { runReadOnlyScenario, runScenarios, ScenarioFailure } from './mcp-scenarios.ts';
import { runStagingProbes } from './staging-probes.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: pnpm test:mcp:staging https://APPROVED_STAGING_HOST/mcp [--wait-for-expiry | --probes | --guard-probes]\nAcceptance: browser login for accounts A, B, then A read-only; writes two synthetic records. Probes: one login, 80 benchmark requests, up to 300 anonymous requests, two rejected mutation checks, and cooldown recovery; retains one synthetic record and two audit receipts. Guard probes: reject three unsafe correction requests against the evaluation fixtures. Credentials remain in memory.',
  );
  process.exit(0);
}
const endpoint = new URL(args[0] ?? 'https://staging.invalid/mcp');
if (
  endpoint.protocol !== 'https:' ||
  endpoint.pathname !== '/mcp' ||
  endpoint.search ||
  endpoint.hash ||
  endpoint.username ||
  endpoint.password ||
  endpoint.hostname.endsWith('.invalid')
)
  throw new Error('Supply the approved HTTPS staging endpoint ending in /mcp.');
if (args.slice(1).some((arg) => !['--wait-for-expiry', '--probes', '--guard-probes'].includes(arg)))
  throw new Error('Unknown option.');
if (args.slice(1).length > 1) throw new Error('Run acceptance and operational probes separately.');

let lastRequestId: string | undefined;

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const outgoing = new Request(input, init);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(outgoing.clone(), {
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    const requestId = response.headers.get('X-Request-Id');
    if (requestId && /^[a-f0-9-]{36}$/.test(requestId)) lastRequestId = requestId;
    if (response.status !== 429 || attempt >= 2) {
      if (!response.ok && lastRequestId)
        console.log(`HTTP ${response.status}; request ID ${lastRequestId}`);
      return response;
    }
    await response.body?.cancel();
    const seconds = Number(response.headers.get('Retry-After') ?? '30');
    await delay(Math.min(60, Math.max(1, Number.isFinite(seconds) ? seconds : 30)) * 1000);
  }
}

function expect(condition: boolean, scenario: string) {
  if (!condition) throw new ScenarioFailure(`Failed: ${scenario}`);
}

async function main() {
  const unauthorized = await request(endpoint, { redirect: 'error' });
  expect(
    unauthorized.status === 401 &&
      !!unauthorized.headers.get('WWW-Authenticate')?.includes('resource_metadata='),
    'unauthenticated discovery challenge',
  );
  const forged = await request(endpoint, {
    headers: { Authorization: 'Bearer invalid-synthetic-token', 'X-User-Id': crypto.randomUUID() },
    redirect: 'error',
  });
  expect(forged.status === 401, 'forged identity denied');
  const a = await stagingLogin(endpoint, 'account A', undefined, request);
  if (args.includes('--guard-probes')) return runCorrectionGuardProbes(endpoint, a.access_token);
  if (args.includes('--probes')) return runStagingProbes(endpoint, a.access_token);
  const b = await stagingLogin(endpoint, 'a DIFFERENT account B', undefined, request);
  const connect = async (account: 'A' | 'B') => {
    const client = new Client({ name: 'contamcp-independent-staging-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: request,
        requestInit: {
          headers: { Authorization: `Bearer ${account === 'A' ? a.access_token : b.access_token}` },
        },
      }),
    );
    return client;
  };
  const result = await runScenarios(connect);
  console.log(
    `PASS: ${result.scenarios} ledger scenarios; ${result.syntheticRecordsCreated} synthetic records retained for audit.`,
  );
  const readOnly = await stagingLogin(
    endpoint,
    'account A again, read-only',
    'expenses:read',
    request,
  );
  const reader = new Client({ name: 'contamcp-read-only-check', version: '1.0.0' });
  try {
    await reader.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: request,
        requestInit: { headers: { Authorization: `Bearer ${readOnly.access_token}` } },
      }),
    );
    await runReadOnlyScenario(reader);
  } finally {
    await reader.close();
  }
  const metadataResponse = await request(
    new URL('/.well-known/oauth-authorization-server', endpoint),
  );
  const metadata = z
    .object({ token_endpoint: z.url(), revocation_endpoint: z.url() })
    .parse(await metadataResponse.json());
  expect(
    new URL(metadata.token_endpoint).origin === endpoint.origin &&
      new URL(metadata.revocation_endpoint).origin === endpoint.origin,
    'canonical OAuth endpoints',
  );
  if (args.includes('--wait-for-expiry')) {
    const until = a.issuedAt + a.expires_in * 1000 + 10_000;
    console.log('Waiting for real access-token expiry; no refresh will run during this check.');
    while (Date.now() < until) await delay(Math.min(30_000, until - Date.now()));
    expect(
      (await request(endpoint, { headers: { Authorization: `Bearer ${a.access_token}` } }))
        .status === 401,
      'expired access token denied',
    );
    console.log('PASS: naturally expired access token denied.');
  } else
    console.log(
      'NOT RUN: natural expiry; rerun with --wait-for-expiry for the full acceptance run.',
    );
  const refreshed = await request(metadata.token_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: a.clientId,
      refresh_token: a.refresh_token,
      resource: endpoint.href,
    }),
  });
  expect(refreshed.ok, 'refresh accepted');
  const tokens = z
    .object({ access_token: z.string(), refresh_token: z.string() })
    .parse(await refreshed.json());
  const refreshedClient = new Client({ name: 'contamcp-refresh-check', version: '1.0.0' });
  try {
    await refreshedClient.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: request,
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }),
    );
    await refreshedClient.listTools();
  } finally {
    await refreshedClient.close();
  }
  const revoke = await request(metadata.revocation_endpoint, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: a.clientId,
      token: tokens.access_token,
      token_type_hint: 'access_token',
    }),
  });
  expect(revoke.ok, 'revocation accepted');
  let rejected = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (
      (await request(endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } }))
        .status === 401
    ) {
      rejected = true;
      break;
    }
    await delay(15_000);
  }
  expect(
    rejected,
    'revocation visible within observation window; investigate KV propagation if not',
  );
  console.log('PASS: unauthenticated/forged requests, read-only scope, refresh and revocation.');
}

try {
  await main();
} catch (error) {
  if (error instanceof ScenarioFailure) console.error(error.message);
  if (lastRequestId) console.error(`Last Worker request ID: ${lastRequestId}`);
  // SDK errors can contain response bodies or callback URLs; never print them.
  console.error(
    'FAIL: staging verification incomplete. Check the last scenario and safe Worker diagnostics. No credentials were saved.',
  );
  process.exitCode = 1;
}
