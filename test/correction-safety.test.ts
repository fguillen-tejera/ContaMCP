import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ledgerStore } from '../src/db/ledger';
import {
  correctionMatchSchema,
  createExpenseSchema,
  expenseSchema,
  updateExpenseSchema,
} from '../src/domain/expense';
import { createExpense, updateExpense } from '../src/expenses/service';
import { bindings, connect, dispatch, expenseInput, principal } from './helpers';

const syntheticInput = (overrides: Record<string, unknown> = {}) =>
  createExpenseSchema.parse(expenseInput(overrides));
const resultSchema = z.object({ expense: expenseSchema });

describe('correction target preconditions', () => {
  it('rejects broad references even when the model supplies one valid ID, without audit writes', async () => {
    const env = bindings();
    const user = await principal(env);
    const client = await connect(env, user.token);
    try {
      const a = resultSchema.parse(
        (await client.callTool({ name: 'create_expense', arguments: syntheticInput() }))
          .structuredContent,
      ).expense;
      await client.callTool({
        name: 'create_expense',
        arguments: syntheticInput({ amount: '250.00' }),
      });
      for (const match of [
        { date: a.date, category: 'transport' },
        { description: a.description },
        { date: a.date, currency: a.currency },
      ]) {
        const r = await client.callTool({
          name: 'update_expense',
          arguments: {
            expenseId: a.id,
            expectedVersion: 1,
            match,
            changes: { amount: '100' },
            idempotencyKey: crypto.randomUUID(),
          },
        });
        expect(r).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'AMBIGUOUS_TARGET' } },
        });
      }
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first('n')).toBe(
        2,
      );
      expect((await ledgerStore(env.DB).findExpense(user.userId, a.id))?.version).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('requires identifying facts, rejects unsupported fields and does not accept an ID as confirmation', () => {
    for (const match of [
      {},
      { currency: 'MXN' },
      { expenseId: crypto.randomUUID() },
      { confirmed: true },
    ])
      expect(correctionMatchSchema.safeParse(match).success).toBe(false);
    expect(
      updateExpenseSchema.safeParse({
        expenseId: crypto.randomUUID(),
        expectedVersion: 1,
        idempotencyKey: 'synthetic-key',
        changes: { amount: '100' },
      }).success,
    ).toBe(false);
  });

  it('uses exact current facts, isolates candidate sets by owner and replays after facts change', async () => {
    const env = bindings();
    const a = await principal(env);
    const b = await principal(env);
    const store = ledgerStore(env.DB);
    const first = await createExpense(store, a.userId, syntheticInput());
    await createExpense(store, a.userId, syntheticInput({ amount: '250.00' }));
    await createExpense(store, b.userId, syntheticInput());
    const input = {
      expenseId: first.id,
      expectedVersion: 1,
      match: {
        date: first.date,
        description: first.description,
        currentAmount: '450',
        currency: first.currency,
      },
      changes: { amount: '405.20' },
      idempotencyKey: crypto.randomUUID(),
    };
    const updated = await updateExpense(store, a.userId, input);
    expect(updated).toMatchObject({ id: first.id, amount: '405.20', version: 2 });
    expect(await updateExpense(store, a.userId, input)).toEqual(updated);
    await expect(
      updateExpense(store, a.userId, { ...input, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      updateExpense(store, b.userId, { ...input, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first('n')).toBe(4);
  });

  it('rejects a uniquely matching reference paired with the wrong record ID', async () => {
    const env = bindings();
    const a = await principal(env);
    const store = ledgerStore(env.DB);
    const first = await createExpense(
      store,
      a.userId,
      syntheticInput({ description: 'SYNTHETIC merchant A' }),
    );
    await createExpense(
      store,
      a.userId,
      syntheticInput({
        description: 'SYNTHETIC merchant B',
        duplicateConfirmation: [{ id: first.id, version: first.version }],
      }),
    );
    await expect(
      updateExpense(store, a.userId, {
        expenseId: first.id,
        expectedVersion: 1,
        match: { description: 'SYNTHETIC merchant B' },
        changes: { amount: '100' },
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first('n')).toBe(2);
  });

  it('atomically rejects a new matching candidate inserted between resolution and commit', async () => {
    const env = bindings();
    const a = await principal(env);
    const store = ledgerStore(env.DB);
    const first = await createExpense(store, a.userId, syntheticInput());
    const racingStore = {
      ...store,
      commit: async (mutation: Parameters<typeof store.commit>[0]) => {
        await createExpense(
          store,
          a.userId,
          syntheticInput({ duplicateConfirmation: [{ id: first.id, version: first.version }] }),
        );
        await store.commit(mutation);
      },
    };
    await expect(
      updateExpense(racingStore, a.userId, {
        expenseId: first.id,
        expectedVersion: 1,
        match: { description: first.description },
        changes: { amount: '100' },
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_TARGET' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first('n')).toBe(2);
    expect((await store.findExpense(a.userId, first.id))?.version).toBe(1);
  });
});

describe('bounded MCP ingestion after authentication', () => {
  it('rejects oversized streamed MCP bodies by bytes before any financial write', async () => {
    const env = bindings();
    const a = await principal(env);
    for (const body of ['x'.repeat(16385), '€'.repeat(6000)]) {
      const bytes = new TextEncoder().encode(body);
      const response = await dispatch(
        new Request(`${env.APP_ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${a.token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
          },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 4000));
              controller.enqueue(bytes.subarray(4000));
              controller.close();
            },
          }),
        }),
        env,
      );
      expect(response.status).toBe(413);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first('n')).toBe(0);
  });
});
