import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { ledgerStore } from '../src/db/ledger';
import { createExpenseSchema, expenseSchema } from '../src/domain/expense';
import { nextOccurrence, recurringSchema } from '../src/domain/planning';
import { createExpense, getCashFlow, updateExpense } from '../src/expenses/service';
import {
  cancelRecurring,
  confirmRecurring,
  createRecurring,
  listRecurring,
} from '../src/planning/recurring';
import { contributeToGoal, createGoal, listGoals, updateGoal } from '../src/planning/goals';
import { bindings, connect, expenseInput, principal } from './helpers';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
const now = new Date('2026-10-23T18:00:00Z');
const key = () => crypto.randomUUID();
const entryInput = (overrides: Record<string, unknown> = {}) =>
  createExpenseSchema.parse(expenseInput(overrides));
async function account(scopes?: string[]) {
  const env = bindings();
  const user = await principal(env, scopes);
  const client = await connect(env, user.token);
  clients.push(client);
  return { env, user, client, store: ledgerStore(env.DB) };
}
const scheduleInput = (overrides: Record<string, unknown> = {}) => ({
  description: 'Netflix',
  type: 'expense' as const,
  amount: '199',
  currency: 'MXN' as const,
  category: 'entertainment' as const,
  interval: 'monthly' as const,
  firstDate: '2026-01-31',
  idempotencyKey: key(),
  ...overrides,
});
const goalInput = () => ({
  name: 'Emergency fund',
  targetAmount: '30000',
  currency: 'MXN' as const,
  idempotencyKey: key(),
});
const contribution = (goalId: string, expectedVersion: number, amount = '0.10') => ({
  goalId,
  expectedVersion,
  amount,
  direction: 'deposit' as const,
  date: '2026-01-01',
  idempotencyKey: key(),
});

describe('income and duplicate protection', () => {
  it('keeps legacy expense views separate and computes exact negative net per currency', async () => {
    const { client } = await account();
    for (const fields of [
      { type: 'income', description: 'Salary', amount: '0.10' },
      { type: 'income', description: 'Refund', amount: '0.20' },
      { type: 'expense', description: 'Bus', amount: '0.50' },
      { type: 'income', description: 'Freelance', amount: '100', currency: 'USD' },
    ])
      expect(
        (
          await client.callTool({
            name: 'create_entry',
            arguments: { ...expenseInput(), ...fields },
          })
        ).isError,
      ).not.toBe(true);
    const cash = await client.callTool({ name: 'get_cash_flow', arguments: {} });
    expect(cash.structuredContent).toEqual({
      totals: [
        { currency: 'MXN', income: '0.30', expenses: '0.50', net: '-0.20', unverifiedCount: 0 },
        { currency: 'USD', income: '100.00', expenses: '0.00', net: '100.00', unverifiedCount: 0 },
      ],
    });
    const legacy = await client.callTool({ name: 'list_expenses', arguments: {} });
    expect(
      z.object({ expenses: z.array(expenseSchema) }).parse(legacy.structuredContent).expenses,
    ).toHaveLength(1);
    const exported = await client.callTool({ name: 'export_entries', arguments: {} });
    expect(z.object({ count: z.number() }).parse(exported.structuredContent).count).toBe(4);
    const oldExport = await client.callTool({ name: 'export_expenses', arguments: {} });
    expect(z.object({ count: z.number() }).parse(oldExport.structuredContent).count).toBe(1);
  });

  it('corrects and deletes income through generic tools while legacy writes remain expense-only', async () => {
    const { client } = await account();
    const entry = z.object({ entry: expenseSchema }).parse(
      (
        await client.callTool({
          name: 'create_entry',
          arguments: expenseInput({ type: 'income', description: 'Consulting', amount: '200' }),
        })
      ).structuredContent,
    ).entry;
    const input = {
      expenseId: entry.id,
      expectedVersion: 1,
      match: { description: entry.description },
      changes: { amount: '250' },
      idempotencyKey: key(),
    };
    expect(
      (await client.callTool({ name: 'update_expense', arguments: input })).structuredContent,
    ).toMatchObject({ error: { code: 'NOT_FOUND' } });
    const updated = z.object({ entry: expenseSchema }).parse(
      (
        await client.callTool({
          name: 'update_entry',
          arguments: {
            entryId: input.expenseId,
            expectedVersion: input.expectedVersion,
            match: input.match,
            changes: input.changes,
            idempotencyKey: input.idempotencyKey,
          },
        })
      ).structuredContent,
    ).entry;
    expect(updated).toMatchObject({ type: 'income', amount: '250.00', version: 2 });
    expect(
      (
        await client.callTool({
          name: 'delete_entry',
          arguments: {
            entryId: entry.id,
            expectedVersion: 2,
            match: { type: 'income', description: entry.description },
            idempotencyKey: key(),
          },
        })
      ).structuredContent,
    ).toMatchObject({ entry: { deletedAt: expect.any(String) } });
    expect(
      (await client.callTool({ name: 'get_cash_flow', arguments: {} })).structuredContent,
    ).toEqual({ totals: [] });
    expect(
      (await client.callTool({ name: 'export_entries', arguments: {} })).structuredContent,
    ).toMatchObject({ count: 1, entries: [{ type: 'income', deletedAt: expect.any(String) }] });
    expect(
      (
        await client.callTool({
          name: 'create_entry',
          arguments: expenseInput({ type: 'income', description: 'Consulting', amount: '250' }),
        })
      ).isError,
    ).not.toBe(true);
  });

  it.each(['update', 'delete'] as const)(
    'does not disclose an income %s receipt when replayed through an expense-only grant',
    async (operation) => {
      const { client, env, user } = await account();
      const legacy = await principal(env, ['expenses:read', 'expenses:write'], user);
      const restricted = await connect(env, legacy.token);
      clients.push(restricted);
      const entry = z.object({ entry: expenseSchema }).parse(
        (
          await client.callTool({
            name: 'create_entry',
            arguments: expenseInput({ type: 'income', description: 'SYNTHETIC income receipt' }),
          })
        ).structuredContent,
      ).entry;
      const input = {
        expectedVersion: entry.version,
        match: { description: entry.description },
        idempotencyKey: key(),
        ...(operation === 'update' ? { changes: { amount: '451.00' } } : {}),
      };
      const original = await client.callTool({
        name: `${operation}_entry`,
        arguments: { ...input, entryId: entry.id },
      });
      expect(original.isError).not.toBe(true);
      const replay = await restricted.callTool({
        name: `${operation}_expense`,
        arguments: { ...input, expenseId: entry.id },
      });
      expect(replay).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'NOT_FOUND' } },
      });
      expect(JSON.stringify(replay)).not.toContain(entry.description);
      expect(
        (
          await client.callTool({
            name: `${operation}_entry`,
            arguments: { ...input, entryId: entry.id },
          })
        ).structuredContent,
      ).toEqual(original.structuredContent);
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations WHERE owner_id = ?')
          .bind(user.userId)
          .first('n'),
      ).toBe(2);
    },
  );

  it('blocks near duplicates without writes, then accepts an explicitly acknowledged separate entry and replays once', async () => {
    const { client, env } = await account();
    const first = z.object({ entry: expenseSchema }).parse(
      (
        await client.callTool({
          name: 'create_entry',
          arguments: expenseInput({
            type: 'income',
            description: 'Pago proyecto Águila',
            amount: '1000',
          }),
        })
      ).structuredContent,
    ).entry;
    const input = expenseInput({
      type: 'income',
      description: 'Proyecto Aguila',
      amount: '1020',
      date: '2026-10-25',
    });
    const warning = await client.callTool({ name: 'create_entry', arguments: input });
    expect(warning).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'POSSIBLE_DUPLICATE', candidates: [{ id: first.id, version: 1 }] },
      },
    });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    const confirmed = { ...input, duplicateConfirmation: [{ id: first.id, version: 1 }] };
    const saved = await client.callTool({ name: 'create_entry', arguments: confirmed });
    expect(saved.isError).not.toBe(true);
    expect(
      (await client.callTool({ name: 'create_entry', arguments: confirmed })).structuredContent,
    ).toEqual(saved.structuredContent);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(2);
    expect(
      (await client.callTool({ name: 'create_entry', arguments: { ...confirmed, amount: '1040' } }))
        .structuredContent,
    ).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('does not confuse owners, currencies, entry types, unrelated descriptions, or distant dates', async () => {
    const { store, env, user } = await account();
    const other = await principal(env);
    await createExpense(store, user.userId, entryInput());
    for (const [owner, fields] of [
      [other.userId, {}],
      [user.userId, { currency: 'USD' }],
      [user.userId, { type: 'income' }],
      [user.userId, { description: 'Dentista' }],
      [user.userId, { date: '2026-11-23' }],
    ] as const)
      await createExpense(store, owner, entryInput(fields));
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(6);
  });

  it('checks duplicate acknowledgements against current versions', async () => {
    const { store, user } = await account();
    const first = await createExpense(store, user.userId, entryInput());
    await updateExpense(store, user.userId, {
      expenseId: first.id,
      expectedVersion: 1,
      match: { description: first.description },
      changes: { amount: '451' },
      idempotencyKey: key(),
    });
    await expect(
      createExpense(
        store,
        user.userId,
        entryInput({ duplicateConfirmation: [{ id: first.id, version: 1 }] }),
      ),
    ).rejects.toMatchObject({ code: 'POSSIBLE_DUPLICATE' });
  });

  it('atomically prevents different-key concurrent duplicates and candidates appearing after the initial check', async () => {
    const { store, env, user } = await account();
    const results = await Promise.allSettled([
      createExpense(store, user.userId, entryInput()),
      createExpense(store, user.userId, entryInput()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'POSSIBLE_DUPLICATE' },
    });
    const racing = {
      ...store,
      commit: async (mutation: Parameters<typeof store.commit>[0]) => {
        await createExpense(
          store,
          user.userId,
          entryInput({ description: 'Netflix', amount: '199' }),
        );
        await store.commit(mutation);
      },
    };
    await expect(
      createExpense(racing, user.userId, entryInput({ description: 'Netflix', amount: '199' })),
    ).rejects.toMatchObject({ code: 'POSSIBLE_DUPLICATE' });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(2);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(2);
  });

  it('requires new consent for financial features instead of expanding existing expense-only grants', async () => {
    const { client } = await account(['expenses:read', 'expenses:write']);
    for (const tool of [
      { name: 'create_entry', arguments: expenseInput({ type: 'income' }) },
      { name: 'get_cash_flow', arguments: {} },
      { name: 'list_savings_goals', arguments: {} },
      { name: 'list_recurring_entries', arguments: {} },
    ])
      expect(await client.callTool(tool)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'FORBIDDEN' } },
      });
    expect(
      (await client.callTool({ name: 'create_expense', arguments: expenseInput() })).isError,
    ).not.toBe(true);
  });
});

describe('recurring expectations and actual payments', () => {
  it('supports the recurring and savings MCP workflow across independent connections', async () => {
    const { client, env, user } = await account();
    const schedule = z
      .object({ recurring: recurringSchema })
      .parse(
        (await client.callTool({ name: 'create_recurring_entry', arguments: scheduleInput() }))
          .structuredContent,
      ).recurring;
    const confirmed = await client.callTool({
      name: 'confirm_recurring_payment',
      arguments: {
        recurringId: schedule.id,
        expectedVersion: 1,
        occurrenceDate: schedule.nextDate,
        paidDate: schedule.nextDate,
        amount: '199',
        idempotencyKey: key(),
      },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(
      (await client.callTool({ name: 'list_entries', arguments: { recurringId: schedule.id } }))
        .structuredContent,
    ).toMatchObject({ entries: [{ recurringId: schedule.id, amount: '199.00' }] });
    const goal = z
      .object({ goal: z.object({ id: z.string(), version: z.number() }) })
      .parse(
        (await client.callTool({ name: 'create_savings_goal', arguments: goalInput() }))
          .structuredContent,
      ).goal;
    expect(
      (
        await client.callTool({
          name: 'contribute_to_savings_goal',
          arguments: contribution(goal.id, goal.version, '500'),
        })
      ).structuredContent,
    ).toMatchObject({ goal: { savedAmount: '500.00', version: 2 } });
    const second = await connect(env, user.token);
    clients.push(second);
    expect(
      (await second.callTool({ name: 'list_savings_goals', arguments: {} })).structuredContent,
    ).toMatchObject({ goals: [{ id: goal.id, savedAmount: '500.00' }] });
    expect(
      (
        await second.callTool({
          name: 'update_savings_goal',
          arguments: {
            goalId: goal.id,
            expectedVersion: 2,
            changes: { deadline: '2027-01-01' },
            idempotencyKey: key(),
          },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await second.callTool({
          name: 'cancel_recurring_entry',
          arguments: { recurringId: schedule.id, expectedVersion: 2, idempotencyKey: key() },
        })
      ).structuredContent,
    ).toMatchObject({ recurring: { active: false } });
  });

  it('clamps month ends while retaining the anchor, including leap years and weekly schedules', () => {
    expect(
      nextOccurrence({ firstDate: '2026-01-31', nextDate: '2026-01-31', interval: 'monthly' }),
    ).toBe('2026-02-28');
    expect(
      nextOccurrence({ firstDate: '2026-01-31', nextDate: '2026-02-28', interval: 'monthly' }),
    ).toBe('2026-03-31');
    expect(
      nextOccurrence({ firstDate: '2024-02-29', nextDate: '2027-02-28', interval: 'yearly' }),
    ).toBe('2028-02-29');
    expect(
      nextOccurrence({ firstDate: '2026-12-28', nextDate: '2026-12-28', interval: 'weekly' }),
    ).toBe('2027-01-04');
    expect(() =>
      nextOccurrence({ firstDate: '9999-12-31', nextDate: '9999-12-31', interval: 'monthly' }),
    ).toThrow();
  });

  it('creates no expense during setup; atomically records actual amount/date, advances once, and replays', async () => {
    const { store, user, env, client } = await account();
    const created = await client.callTool({
      name: 'create_recurring_entry',
      arguments: scheduleInput(),
    });
    const recurring = z
      .object({ recurring: recurringSchema })
      .parse(created.structuredContent).recurring;
    expect(await getCashFlow(store, user.userId, {})).toEqual({ totals: [] });
    expect(
      (await listRecurring(store, user.userId, { dueThrough: '2026-02-01' }, now)).recurring[0]
        ?.due,
    ).toBe(true);
    const input = {
      recurringId: recurring.id,
      expectedVersion: 1,
      occurrenceDate: '2026-01-31',
      paidDate: '2026-02-02',
      amount: '201.50',
      idempotencyKey: key(),
    };
    const paid = await confirmRecurring(store, user.userId, input, now);
    expect(paid).toMatchObject({
      amount: '201.50',
      date: '2026-02-02',
      recurringId: recurring.id,
      occurrenceDate: '2026-01-31',
    });
    expect(await confirmRecurring(store, user.userId, input, now)).toEqual(paid);
    expect(await store.findRecurring(user.userId, recurring.id)).toMatchObject({
      nextDate: '2026-02-28',
      version: 2,
    });
    await expect(
      confirmRecurring(store, user.userId, { ...input, idempotencyKey: key() }, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM planning_mutations').first('n')).toBe(2);
  });

  it('links an already-recorded income payment without adding another record', async () => {
    const { store, user, env } = await account();
    const recurring = await createRecurring(
      store,
      user.userId,
      scheduleInput({ type: 'income', description: 'Salary', amount: '15000' }),
      now,
    );
    const entry = await createExpense(
      store,
      user.userId,
      entryInput({
        type: 'income',
        description: 'Monthly salary',
        amount: '15000',
        date: '2026-01-30',
      }),
      now,
    );
    const input = {
      recurringId: recurring.id,
      expectedVersion: 1,
      occurrenceDate: recurring.nextDate,
      paidDate: entry.date,
      amount: entry.amount,
      existingEntryId: entry.id,
      expectedEntryVersion: entry.version,
      idempotencyKey: key(),
    };
    expect(await confirmRecurring(store, user.userId, input, now)).toMatchObject({
      id: entry.id,
      version: 2,
      recurringId: recurring.id,
    });
    expect(await confirmRecurring(store, user.userId, input, now)).toMatchObject({
      id: entry.id,
      version: 2,
    });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await store.findRecurring(user.userId, recurring.id)).toMatchObject({
      version: 2,
      nextDate: '2026-02-28',
    });
  });

  it('does not advance on a duplicate warning and prevents recording the same occurrence concurrently', async () => {
    const { store, user, env } = await account();
    const recurring = await createRecurring(store, user.userId, scheduleInput(), now);
    const existing = await createExpense(
      store,
      user.userId,
      entryInput({ description: 'Netflix', amount: '199', date: recurring.nextDate }),
      now,
    );
    const input = {
      recurringId: recurring.id,
      expectedVersion: 1,
      occurrenceDate: recurring.nextDate,
      paidDate: recurring.nextDate,
      amount: '199',
      idempotencyKey: key(),
    };
    await expect(confirmRecurring(store, user.userId, input, now)).rejects.toMatchObject({
      code: 'POSSIBLE_DUPLICATE',
    });
    expect((await store.findRecurring(user.userId, recurring.id))?.version).toBe(1);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        confirmRecurring(
          store,
          user.userId,
          {
            ...input,
            duplicateConfirmation: [{ id: existing.id, version: existing.version }],
            idempotencyKey: key(),
          },
          now,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(2);
    expect((await store.findRecurring(user.userId, recurring.id))?.version).toBe(2);
  });

  it('rolls back ledger, audit, and schedule together on receipt failure', async () => {
    const { store, user, env } = await account();
    const recurring = await createRecurring(store, user.userId, scheduleInput(), now);
    await env.DB.exec(
      "CREATE TRIGGER fail_schedule BEFORE INSERT ON planning_mutations WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    try {
      await expect(
        confirmRecurring(
          store,
          user.userId,
          {
            recurringId: recurring.id,
            expectedVersion: 1,
            occurrenceDate: recurring.nextDate,
            paidDate: recurring.nextDate,
            amount: '199',
            idempotencyKey: key(),
          },
          now,
        ),
      ).rejects.toThrow();
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(0);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(0);
      expect((await store.findRecurring(user.userId, recurring.id))?.version).toBe(1);
    } finally {
      await env.DB.exec('DROP TRIGGER fail_schedule');
    }
  });

  it('cancels with version checks, excludes inactive schedules, and rejects future payments and foreign owners', async () => {
    const { store, user, env } = await account();
    const other = await principal(env);
    const recurring = await createRecurring(store, user.userId, scheduleInput(), now);
    const input = {
      recurringId: recurring.id,
      expectedVersion: 1,
      occurrenceDate: recurring.nextDate,
      paidDate: '2027-01-01',
      amount: '199',
      idempotencyKey: key(),
    };
    await expect(confirmRecurring(store, user.userId, input, now)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(confirmRecurring(store, other.userId, input, now)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const canceled = await cancelRecurring(
      store,
      user.userId,
      { recurringId: recurring.id, expectedVersion: 1, idempotencyKey: key() },
      now,
    );
    expect(canceled.active).toBe(false);
    expect((await listRecurring(store, user.userId, {})).recurring).toEqual([]);
    expect(
      (await listRecurring(store, user.userId, { includeInactive: true })).recurring,
    ).toHaveLength(1);
    await expect(
      confirmRecurring(store, user.userId, { ...input, paidDate: recurring.nextDate }, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('explicit savings allocations', () => {
  it('sums exact cents with idempotent deposits/withdrawals, keeps original retry receipts, and never changes cash flow', async () => {
    const { store, user, env, client } = await account();
    const goal = await createGoal(store, user.userId, goalInput(), now);
    const firstInput = contribution(goal.id, goal.version);
    const first = await contributeToGoal(store, user.userId, firstInput, now);
    const second = await contributeToGoal(
      store,
      user.userId,
      contribution(goal.id, first.version, '0.20'),
      now,
    );
    expect(second).toMatchObject({
      savedMinor: '30',
      savedAmount: '0.30',
      remainingAmount: '29999.70',
    });
    expect(await contributeToGoal(store, user.userId, firstInput, now)).toEqual(first);
    const withdrawn = await contributeToGoal(
      store,
      user.userId,
      { ...contribution(goal.id, second.version, '0.10'), direction: 'withdraw' },
      now,
    );
    expect(withdrawn.savedAmount).toBe('0.20');
    await expect(
      contributeToGoal(
        store,
        user.userId,
        { ...contribution(goal.id, withdrawn.version, '1'), direction: 'withdraw' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await getCashFlow(store, user.userId, {})).toEqual({ totals: [] });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(0);
    expect(
      (await client.callTool({ name: 'list_savings_goals', arguments: {} })).structuredContent,
    ).toMatchObject({ goals: [{ savedAmount: '0.20' }] });
  });

  it('preserves one winner for concurrent allocations and rejects changed-key payloads and foreign writes', async () => {
    const { store, user, env } = await account();
    const other = await principal(env);
    const goal = await createGoal(store, user.userId, goalInput(), now);
    const input = contribution(goal.id, 1);
    const attempts = [input, { ...input, idempotencyKey: key() }];
    const results = await Promise.allSettled(
      attempts.map((value) => contributeToGoal(store, user.userId, value, now)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });
    const winner = attempts[results.findIndex((result) => result.status === 'fulfilled')];
    if (!winner) throw new Error('Missing winning attempt');
    const stored = await contributeToGoal(store, user.userId, winner, now);
    await expect(
      contributeToGoal(store, user.userId, { ...winner, amount: '1' }, now),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      contributeToGoal(store, other.userId, { ...input, expectedVersion: stored.version }, now),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await listGoals(store, other.userId, {})).goals).toEqual([]);
  });

  it('supports target changes and archive/reactivation without resetting savings', async () => {
    const { store, user } = await account();
    const goal = await createGoal(store, user.userId, goalInput(), now);
    const funded = await contributeToGoal(store, user.userId, contribution(goal.id, 1, '100'), now);
    const reached = await updateGoal(
      store,
      user.userId,
      {
        goalId: goal.id,
        expectedVersion: funded.version,
        changes: { targetAmount: '50', active: false, deadline: null },
        idempotencyKey: key(),
      },
      now,
    );
    expect(reached).toMatchObject({
      reached: true,
      savedAmount: '100.00',
      remainingAmount: '0.00',
      active: false,
    });
    expect((await listGoals(store, user.userId, {})).goals).toEqual([]);
    await expect(
      contributeToGoal(store, user.userId, contribution(goal.id, reached.version), now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const reopened = await updateGoal(
      store,
      user.userId,
      {
        goalId: goal.id,
        expectedVersion: reached.version,
        changes: { active: true },
        idempotencyKey: key(),
      },
      now,
    );
    expect(reopened.savedAmount).toBe('100.00');
  });

  it('rolls back saved balance on audit failure and rejects future or overflowing contributions', async () => {
    const { store, user, env } = await account();
    const goal = await createGoal(store, user.userId, goalInput(), now);
    await expect(
      contributeToGoal(
        store,
        user.userId,
        { ...contribution(goal.id, 1), date: '2027-01-01' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await env.DB.exec(
      "CREATE TRIGGER fail_goal BEFORE INSERT ON planning_mutations WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    try {
      await expect(
        contributeToGoal(store, user.userId, contribution(goal.id, 1), now),
      ).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER fail_goal');
    }
    expect((await store.findGoal(user.userId, goal.id))?.savedMinor).toBe('0');
    const full = await contributeToGoal(
      store,
      user.userId,
      contribution(goal.id, 1, '9999999999.99'),
      now,
    );
    await expect(
      contributeToGoal(store, user.userId, contribution(goal.id, full.version), now),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('paginates plans without crossing owners and keeps goal/schedule retry keys in one planning namespace', async () => {
    const { store, user, env } = await account();
    const other = await principal(env);
    const created = [];
    for (let i = 0; i < 3; i++)
      created.push(await createGoal(store, user.userId, { ...goalInput(), name: `Goal ${i}` }));
    await createGoal(store, other.userId, goalInput());
    const seen: string[] = [];
    let afterId: string | undefined;
    do {
      const page = await listGoals(store, user.userId, { limit: 1, afterId });
      seen.push(...page.goals.map((goal) => goal.id));
      afterId = page.nextAfterId ?? undefined;
    } while (afterId);
    expect([...seen].sort()).toEqual(created.map((goal) => goal.id).sort());
    const shared = key();
    await createGoal(store, user.userId, { ...goalInput(), idempotencyKey: shared });
    await expect(
      createRecurring(store, user.userId, { ...scheduleInput(), idempotencyKey: shared }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('enforces read-only grants on every new mutation and rejects unknown identity fields', async () => {
    const { client, user } = await account(['ledger:read']);
    for (const tool of [
      { name: 'create_entry', arguments: expenseInput({ type: 'income' }) },
      { name: 'create_recurring_entry', arguments: scheduleInput() },
      { name: 'create_savings_goal', arguments: goalInput() },
      { name: 'contribute_to_savings_goal', arguments: contribution(key(), 1) },
      {
        name: 'update_savings_goal',
        arguments: {
          goalId: key(),
          expectedVersion: 1,
          changes: { name: 'Other' },
          idempotencyKey: key(),
        },
      },
      {
        name: 'cancel_recurring_entry',
        arguments: { recurringId: key(), expectedVersion: 1, idempotencyKey: key() },
      },
      {
        name: 'confirm_recurring_payment',
        arguments: {
          recurringId: key(),
          expectedVersion: 1,
          occurrenceDate: '2026-01-31',
          paidDate: '2026-01-31',
          amount: '199',
          idempotencyKey: key(),
        },
      },
    ])
      expect(await client.callTool(tool)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'FORBIDDEN' } },
      });
    expect(
      (
        await client.callTool({
          name: 'create_savings_goal',
          arguments: { ...goalInput(), userId: user.userId },
        })
      ).isError,
    ).toBe(true);
  });
});
