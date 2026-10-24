import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { expenseSchema } from '../src/domain/expense.ts';
import { ScenarioFailure } from './mcp-scenarios.ts';

export async function runCorrectionGuardProbes(endpoint: URL, accessToken: string) {
  const client = new Client({ name: 'contamcp-correction-guard-probe', version: '1' });
  const page = z.object({ expenses: z.array(expenseSchema), nextCursor: z.string().nullable() });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    );
    const snapshot = async () =>
      page.parse(
        (
          await client.callTool({
            name: 'list_expenses',
            arguments: { from: '2088-02-01', to: '2088-02-01', limit: 100 },
          })
        ).structuredContent,
      );
    const before = await snapshot();
    const a = before.expenses.find(
      (e) => e.description === 'SYNTHETIC risk23-post a-category comida A',
    );
    const b = before.expenses.find(
      (e) => e.description === 'SYNTHETIC risk23-post a-category comida B',
    );
    if (!a || !b || before.nextCursor)
      throw new ScenarioFailure('Required isolated synthetic fixtures are unavailable.');
    for (const [match, expected] of [
      [{ date: a.date, category: 'food_drink', currency: 'MXN' }, 'AMBIGUOUS_TARGET'],
      [{ date: b.date, description: b.description }, 'CONFLICT'],
    ] as const) {
      const r = await client.callTool({
        name: 'update_expense',
        arguments: {
          expenseId: a.id,
          expectedVersion: a.version,
          match,
          changes: { amount: '0.01' },
          idempotencyKey: crypto.randomUUID(),
        },
      });
      if (
        !r.isError ||
        !z.object({ error: z.object({ code: z.literal(expected) }) }).safeParse(r.structuredContent)
          .success
      )
        throw new ScenarioFailure('Correction precondition was not rejected as expected.');
    }
    const missing = await client.callTool({
      name: 'update_expense',
      arguments: {
        expenseId: a.id,
        expectedVersion: a.version,
        changes: { amount: '0.01' },
        idempotencyKey: crypto.randomUUID(),
      },
    });
    if (!missing.isError) throw new ScenarioFailure('Missing correction match was accepted.');
    if (JSON.stringify(await snapshot()) !== JSON.stringify(before))
      throw new ScenarioFailure('Rejected correction changed synthetic records.');
    console.log(
      'PASS: hosted ambiguous match, mismatched ID and missing match rejected; synthetic fixture snapshot unchanged. Verify audit counts independently.',
    );
  } finally {
    await client.close();
  }
}
