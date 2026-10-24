import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';

const expense = z.object({ id: z.uuid(), amountMinor: z.string(), version: z.number().int() });
const expenseResult = z.object({ expense });
const listResult = z.object({ expenses: z.array(expense), nextCursor: z.string().nullable() });
const summaryResult = z.object({
  totals: z.array(
    z.object({ currency: z.string(), amountMinor: z.string(), count: z.number().int() }),
  ),
});
const errorResult = z.object({ error: z.object({ code: z.string() }) });

export class ScenarioFailure extends Error {}

function check(condition: boolean, scenario: string): asserts condition {
  if (!condition) throw new ScenarioFailure(`Scenario failed: ${scenario}`);
}

export async function runReadOnlyScenario(client: Client) {
  const denied = await client.callTool({
    name: 'create_expense',
    arguments: {
      description: 'SYNTHETIC forbidden write',
      amount: '0.10',
      currency: 'MXN',
      date: '2099-12-30',
      category: 'travel',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  check(
    denied.isError === true &&
      errorResult.safeParse(denied.structuredContent).data?.error.code === 'FORBIDDEN',
    'read-only scope',
  );
  const challenges = z.array(z.string()).safeParse(denied._meta?.['mcp/www_authenticate']);
  check(
    challenges.success && challenges.data.some((value) => value.includes('insufficient_scope')),
    'read-only scope challenge',
  );
}

export async function runScenarios(connect: (account: 'A' | 'B') => Promise<Client>) {
  const a = await connect('A');
  let b: Client | undefined;
  let next: Client | undefined;
  const filter = { from: '2099-12-30', to: '2099-12-30', currency: 'MXN', category: 'travel' };
  const input = {
    description: `SYNTHETIC ContaMCP staging test ${crypto.randomUUID()}`,
    amount: '0.10',
    currency: 'MXN',
    date: filter.from,
    category: filter.category,
    idempotencyKey: crypto.randomUUID(),
  };
  try {
    b = await connect('B');
    const tools = (await a.listTools()).tools;
    check(
      [
        'create_expense',
        'list_expenses',
        'update_expense',
        'delete_expense',
        'get_expense_summary',
        'export_expenses',
      ].every((name) => tools.some((tool) => tool.name === name)),
      'required expense tools discovered',
    );
    const summary = async (client: Client) => {
      const result = summaryResult.parse(
        (await client.callTool({ name: 'get_expense_summary', arguments: filter }))
          .structuredContent,
      );
      return {
        minor: BigInt(result.totals[0]?.amountMinor ?? '0'),
        count: result.totals[0]?.count ?? 0,
      };
    };
    const beforeA = await summary(a);
    const beforeB = await summary(b);
    const created = await Promise.all([
      a.callTool({ name: 'create_expense', arguments: input }),
      a.callTool({ name: 'create_expense', arguments: input }),
    ]);
    const first = expenseResult.parse(created[0]?.structuredContent).expense;
    check(
      expenseResult.parse(created[1]?.structuredContent).expense.id === first.id,
      'concurrent creation retry',
    );
    await a.close();
    next = await connect('A');
    const page = listResult.parse(
      (await next.callTool({ name: 'list_expenses', arguments: { ...filter, limit: 100 } }))
        .structuredContent,
    );
    // Fetch every page so previous synthetic runs cannot hide a record from the assertion.
    const all = [...page.expenses];
    let cursor = page.nextCursor;
    while (cursor) {
      const page = listResult.parse(
        (
          await next.callTool({
            name: 'list_expenses',
            arguments: { ...filter, limit: 100, cursor },
          })
        ).structuredContent,
      );
      all.push(...page.expenses);
      cursor = page.nextCursor;
    }
    check(
      all.filter((row) => row.id === first.id).length === 1,
      'retrieval in a separate connection',
    );
    const other = expenseResult.parse(
      (await b.callTool({ name: 'create_expense', arguments: input })).structuredContent,
    ).expense;
    check(other.id !== first.id, 'two distinct accounts and separate retry namespaces');
    const denied = await b.callTool({
      name: 'update_expense',
      arguments: {
        expenseId: first.id,
        match: { description: input.description },
        expectedVersion: 1,
        changes: { amount: '9.99' },
        idempotencyKey: crypto.randomUUID(),
      },
    });
    check(
      denied.isError === true &&
        errorResult.parse(denied.structuredContent).error.code === 'NOT_FOUND',
      'foreign record update denied',
    );
    const foreignPage = listResult.parse(
      (await b.callTool({ name: 'list_expenses', arguments: { ...filter, limit: 100 } }))
        .structuredContent,
    );
    check(!foreignPage.expenses.some((row) => row.id === first.id), 'foreign record absent');
    const correction = {
      expenseId: first.id,
      match: { description: input.description },
      expectedVersion: 1,
      changes: { amount: '0.30' },
      idempotencyKey: crypto.randomUUID(),
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const updated = expenseResult.parse(
        (await next.callTool({ name: 'update_expense', arguments: correction })).structuredContent,
      ).expense;
      check(updated.version === 2 && updated.amountMinor === '30', 'correction and retry');
    }
    const afterA = await summary(next);
    const afterB = await summary(b);
    check(
      afterA.minor === beforeA.minor + 30n && afterA.count === beforeA.count + 1,
      'exact totals after retries',
    );
    check(
      afterB.minor === beforeB.minor + 10n && afterB.count === beforeB.count + 1,
      'isolated account totals',
    );
    const conflict = await next.callTool({
      name: 'create_expense',
      arguments: { ...input, amount: '0.20' },
    });
    check(
      conflict.isError === true &&
        errorResult.parse(conflict.structuredContent).error.code === 'IDEMPOTENCY_CONFLICT',
      'changed retry payload denied',
    );
    const invalid = await next.callTool({
      name: 'create_expense',
      arguments: { ...input, amount: 'not-money', idempotencyKey: crypto.randomUUID() },
    });
    check(invalid.isError === true, 'invalid input denied');
    const stale = await next.callTool({
      name: 'update_expense',
      arguments: { ...correction, idempotencyKey: crypto.randomUUID() },
    });
    check(
      stale.isError === true &&
        errorResult.parse(stale.structuredContent).error.code === 'CONFLICT',
      'stale version denied',
    );
    return { scenarios: 12, syntheticRecordsCreated: 2 };
  } finally {
    await Promise.allSettled([a.close(), b?.close(), next?.close()]);
  }
}
