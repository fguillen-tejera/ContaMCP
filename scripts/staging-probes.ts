import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { ScenarioFailure } from './mcp-scenarios.ts';

const expenseResult = z.object({
  expense: z.object({ id: z.uuid(), version: z.number().int() }),
});

export async function observeMutationThrottling(
  replay: (kind: 'create' | 'update') => Promise<boolean>,
  pause: (milliseconds: number) => Promise<unknown> = delay,
) {
  const rejected = { create: false, update: false };
  // Binding counts propagate between instances in the background, even within one location.
  for (let attempt = 0; attempt < 8; attempt++) {
    for (const kind of ['create', 'update'] as const) {
      if (!rejected[kind]) rejected[kind] = await replay(kind);
    }
    if (rejected.create && rejected.update) return true;
    if (attempt < 7) await pause(500);
  }
  return false;
}

export async function runStagingProbes(
  endpoint: URL,
  accessToken: string,
  mode: 'cpu' | 'full' = 'full',
) {
  const client = new Client({ name: 'contamcp-operational-probe', version: '1.0.0' });
  let operation = 'connect';
  let lastStatus = 0;
  let lastRetryAfter: string | null = null;
  const request: typeof fetch = async (input, init) => {
    const response = await fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    lastStatus = response.status;
    lastRetryAfter = response.headers.get('Retry-After');
    const colo = response.headers.get('CF-Ray')?.split('-').at(-1);
    const requestId = response.headers.get('X-Request-Id');
    console.log(
      JSON.stringify({
        operation,
        time: new Date().toISOString(),
        status: response.status,
        requestId: requestId && /^[a-f0-9-]{36}$/.test(requestId) ? requestId : undefined,
        colo: colo && /^[A-Z]{3}$/.test(colo) ? colo : undefined,
      }),
    );
    return response;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        fetch: request,
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    const filter = { from: '2099-12-29', to: '2099-12-29', category: 'other', currency: 'MXN' };
    const creation = {
      description: `SYNTHETIC ${crypto.randomUUID().replaceAll('-', '')} ${crypto.randomUUID().replaceAll('-', '')}`,
      amount: '0.10',
      currency: 'MXN',
      date: filter.from,
      category: filter.category,
      idempotencyKey: crypto.randomUUID(),
    };
    operation = 'create-once';
    const created = expenseResult.parse(
      (await client.callTool({ name: 'create_expense', arguments: creation })).structuredContent,
    ).expense;
    const correction = {
      expenseId: created.id,
      match: { description: creation.description },
      expectedVersion: created.version,
      changes: { amount: '0.20' },
      idempotencyKey: crypto.randomUUID(),
    };
    const cases: { name: string; run: () => Promise<unknown> }[] = [
      { name: 'tools-list', run: () => client.listTools() },
      {
        name: 'list-expenses',
        run: () => client.callTool({ name: 'list_expenses', arguments: filter }),
      },
      {
        name: 'summary',
        run: () => client.callTool({ name: 'get_expense_summary', arguments: filter }),
      },
      {
        name: 'create-retry',
        run: () => client.callTool({ name: 'create_expense', arguments: creation }),
      },
      {
        name: 'update-retry',
        run: () => client.callTool({ name: 'update_expense', arguments: correction }),
      },
    ];
    for (const scenario of cases) {
      operation = scenario.name;
      console.log(JSON.stringify({ phase: operation, start: new Date().toISOString() }));
      for (let i = 0; i < 16; i++) {
        const result = await scenario.run();
        if (z.object({ isError: z.literal(true) }).safeParse(result).success)
          throw new Error('Operational tool probe failed.');
        await delay(300);
      }
      console.log(JSON.stringify({ phase: operation, end: new Date().toISOString() }));
    }
    console.log(
      'PASS: CPU traffic complete; one synthetic expense and two audit receipts retained.',
    );
    if (mode === 'cpu') return;
    operation = 'cooldown';
    await delay(65_000);
    operation = 'rate-limit';
    let rejected = false;
    for (let i = 0; i < 300; i++) {
      const response = await request(endpoint);
      await response.body?.cancel();
      if (response.status === 429) {
        rejected = true;
        console.log(
          JSON.stringify({
            phase: 'ingress-rejected',
            request: i + 1,
            retryAfter: response.headers.get('Retry-After'),
            time: new Date().toISOString(),
          }),
        );
        break;
      }
      if (response.status !== 401) throw new Error('Unexpected anonymous probe status.');
      await delay(100);
    }
    const mutationsRejected =
      rejected &&
      (await observeMutationThrottling(async (kind) => {
        operation = `rate-limit-${kind}`;
        lastStatus = 0;
        try {
          // Reuse the original input/key: an allowed request must only replay its existing receipt.
          const result = expenseResult.parse(
            (
              await client.callTool({
                name: kind === 'create' ? 'create_expense' : 'update_expense',
                arguments: kind === 'create' ? creation : correction,
              })
            ).structuredContent,
          ).expense;
          if (result.id !== created.id || result.version !== (kind === 'create' ? 1 : 2))
            throw new Error('Unexpected replay receipt.');
          return false;
        } catch {
          if (lastStatus === 429 && lastRetryAfter === '60') return true;
          throw new ScenarioFailure('Failed: bounded operational mutation replay.');
        }
      }));
    console.log(
      mutationsRejected
        ? 'PASS: create and update replays observed HTTP 429 with retry guidance.'
        : 'INCONCLUSIVE: throttling was not observed for every request class within the bounded window.',
    );
    await delay(65_000);
    operation = 'recovery';
    await client.listTools();
    if ((await client.callTool({ name: 'list_expenses', arguments: filter })).isError)
      throw new ScenarioFailure('Failed: authenticated read after cooldown.');
    console.log('PASS: legitimate authenticated discovery and read recovered after cooldown.');
    if (!mutationsRejected)
      throw new ScenarioFailure(
        'Incomplete: bounded throttling observation; recovery was checked separately.',
      );
  } finally {
    await client.close();
  }
}
