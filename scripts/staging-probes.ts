import { setTimeout as delay } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';

const expenseResult = z.object({
  expense: z.object({ id: z.uuid(), version: z.number().int() }),
});

export async function runStagingProbes(endpoint: URL, accessToken: string) {
  const client = new Client({ name: 'contamcp-operational-probe', version: '1.0.0' });
  let operation = 'connect';
  const request: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });
    console.log(
      JSON.stringify({
        operation,
        time: new Date().toISOString(),
        status: response.status,
        requestId: response.headers.get('X-Request-Id'),
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
      description: `SYNTHETIC operational probe ${crypto.randomUUID()}`,
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
    operation = 'cooldown';
    await delay(65_000);
    operation = 'rate-limit';
    let rejected = false;
    for (let i = 0; i < 300; i++) {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(20_000) });
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
    if (!rejected) throw new Error('No hosted MCP 429 observed within 300-request bound.');
    for (const [name, args] of [
      ['create_expense', { ...creation, idempotencyKey: crypto.randomUUID() }],
      [
        'update_expense',
        {
          ...correction,
          expectedVersion: 2,
          changes: { amount: '0.30' },
          idempotencyKey: crypto.randomUUID(),
        },
      ],
    ] as const) {
      const response = await request(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-03-26',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      await response.body?.cancel();
      if (response.status !== 429 || response.headers.get('Retry-After') !== '60')
        throw new Error('Mutation was not throttled; inspect retained synthetic audit history.');
    }
    console.log(
      'PASS: valid create and update rejected with HTTP 429. Verify D1 audit counts independently.',
    );
    await delay(65_000);
    operation = 'recovery';
    await client.listTools();
    await client.callTool({ name: 'list_expenses', arguments: filter });
    console.log('PASS: legitimate authenticated discovery and read recovered after cooldown.');
  } finally {
    await client.close();
  }
}
