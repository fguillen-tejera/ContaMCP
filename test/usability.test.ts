import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { ledgerStore, verifyAuditChain } from '../src/db/ledger';
import { createExpenseSchema, type expenseSchema } from '../src/domain/expense';
import {
  backupDatasetSchema,
  budgetSchema,
  reportSchema,
  setBudgetSchema,
} from '../src/domain/insights';
import {
  createExpense,
  deleteExpense,
  listExpenses,
  restoreEntry,
  updateExpense,
} from '../src/expenses/service';
import {
  exportBackup,
  exportEntryPage,
  getActivityHistory,
  getLedgerReport,
} from '../src/expenses/queries';
import {
  getPreferences,
  listMonthlyBudgets,
  setMonthlyBudget,
  setPreferences,
} from '../src/planning/budgets';
import { confirmRecurring, createRecurring, listRecurring } from '../src/planning/recurring';
import { contributeToGoal, createGoal } from '../src/planning/goals';
import { recordAutomaticOccurrence } from '../src/planning/automatic';
import { bindings, connect, expenseInput, principal } from './helpers';

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});
const now = new Date('2026-10-23T18:00:00Z');
const key = () => crypto.randomUUID();
async function account(scopes?: string[]) {
  const env = bindings();
  const user = await principal(env, scopes);
  const store = ledgerStore(env.DB);
  const client = await connect(env, user.token);
  clients.push(client);
  const create = (fields: Record<string, unknown> = {}) =>
    createExpense(store, user.userId, createExpenseSchema.parse(expenseInput(fields)), now);
  return { env, user, store, client, create };
}
const budgetInput = (fields: Record<string, unknown> = {}) =>
  setBudgetSchema.parse({
    month: '2026-10',
    category: 'transport',
    currency: 'MXN',
    limitAmount: '500',
    idempotencyKey: key(),
    ...fields,
  });
const scheduleInput = (date = '2026-10-01') => ({
  description: 'Synthetic membership',
  type: 'expense' as const,
  amount: '199',
  currency: 'MXN' as const,
  category: 'entertainment' as const,
  interval: 'monthly' as const,
  firstDate: date,
  automatic: false,
  idempotencyKey: key(),
});
const deletion = (entry: z.infer<typeof expenseSchema>) => ({
  expenseId: entry.id,
  expectedVersion: entry.version,
  match: { description: entry.description, date: entry.date, currentAmount: entry.amount },
  idempotencyKey: key(),
});

describe('search and exact reports', () => {
  it('searches literal descriptions with Spanish accents, amount bounds, dates, pagination, and owner isolation', async () => {
    const { env, user, store, client, create } = await account();
    const a = await create({ description: 'CAFÉ Pemex 100%_A', amount: '100', date: '2026-10-01' });
    const b = await create({ description: 'Café Pemex Centro', amount: '200', date: '2026-10-10' });
    await create({ description: 'PEMEX fuera', amount: '201', date: '2026-09-30' });
    const other = await principal(env);
    await createExpense(
      store,
      other.userId,
      createExpenseSchema.parse(expenseInput({ description: 'Café Pemex privado', amount: '150' })),
      now,
    );
    const filter = {
      query: 'cafe pemex',
      minAmount: '100',
      maxAmount: '200',
      from: '2026-10-01',
      to: '2026-10-31',
      limit: 1,
    };
    const first = await listExpenses(store, user.userId, filter);
    expect(first.expenses.map((item) => item.id)).toEqual([b.id]);
    const second = await listExpenses(store, user.userId, {
      ...filter,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.expenses.map((item) => item.id)).toEqual([a.id]);
    expect(second.nextCursor).toBeNull();
    expect(
      (await listExpenses(store, user.userId, { query: '%_A' })).expenses.map((item) => item.id),
    ).toEqual([a.id]);
    expect((await listExpenses(store, user.userId, { query: "' OR 1=1 --" })).expenses).toEqual([]);
    expect(
      (
        await client.callTool({
          name: 'list_entries',
          arguments: { minAmount: '200', maxAmount: '100' },
        })
      ).isError,
    ).toBe(true);
  });

  it('groups categories/months and compares adjacent periods without mixing currencies or deleted entries', async () => {
    const { env, store, user, client, create } = await account();
    const other = await principal(env);
    await createExpense(
      store,
      other.userId,
      createExpenseSchema.parse(
        expenseInput({ description: 'Private report amount', amount: '99999' }),
      ),
      now,
    );
    await create({
      type: 'income',
      description: 'Synthetic salary',
      amount: '100',
      date: '2026-10-01',
      category: 'other',
    });
    await create({ description: 'Bus octubre', amount: '0.10', date: '2026-10-01' });
    await create({ description: 'Metro octubre', amount: '0.20', date: '2026-10-02' });
    await create({
      description: 'Lunch USD',
      amount: '10',
      currency: 'USD',
      category: 'food_drink',
      date: '2026-10-02',
    });
    await create({ description: 'Previous bus', amount: '1.00', date: '2026-09-01' });
    const deleted = await create({
      description: 'Deleted spending',
      amount: '999',
      date: '2026-10-15',
    });
    await deleteExpense(store, user.userId, deletion(deleted), now);
    const result = await getLedgerReport(store, user.userId, {
      from: '2026-10-01',
      to: '2026-10-31',
      comparePrevious: true,
    });
    expect(result.previous).toMatchObject({ from: '2026-08-31', to: '2026-09-30' });
    expect(result.current.totals).toEqual([
      { currency: 'MXN', income: '100.00', expenses: '0.30', net: '99.70', unverifiedCount: 0 },
      { currency: 'USD', income: '0.00', expenses: '10.00', net: '-10.00', unverifiedCount: 0 },
    ]);
    expect(result.current.groups.find((row) => row.bucket === 'transport')).toMatchObject({
      amount: '0.30',
      amountMinor: '30',
      count: 2,
    });
    expect(result.changes).toContainEqual({
      currency: 'MXN',
      incomeDifference: '100.00',
      expenseDifference: '-0.70',
      netDifference: '100.70',
    });
    const monthly = await client.callTool({
      name: 'get_ledger_report',
      arguments: {
        from: '2026-09-01',
        to: '2026-10-31',
        groupBy: 'month',
        type: 'expense',
        currency: 'MXN',
      },
    });
    expect(monthly.isError).not.toBe(true);
    expect(monthly.structuredContent).toMatchObject({
      current: {
        groups: [
          { bucket: '2026-09', amount: '1.00' },
          { bucket: '2026-10', amount: '0.30' },
        ],
      },
    });
    expect(reportSchema.safeParse({ from: '2025-01-01', to: '2026-12-31' }).success).toBe(false);
    await expect(
      getLedgerReport(store, user.userId, {
        from: '1900-01-01',
        to: '1900-01-02',
        comparePrevious: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      (await getLedgerReport(store, user.userId, { from: '2026-01-01', to: '2026-01-31' })).current
        .totals,
    ).toEqual([]);
  });

  it('keeps SQL report/budget sums exact beyond the JavaScript safe integer range', async () => {
    const { env, store, user } = await account();
    await env.DB.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n < 10001)
      INSERT INTO expenses (id,owner_id,description,amount_minor,currency,date,category,version,created_at,updated_at)
      SELECT 'synthetic-large-' || n, ?, 'SYNTHETIC large sum', 999999999999, 'MXN', '2026-10-01', 'transport', 1, '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z' FROM sequence`)
      .bind(user.userId)
      .run();
    await setMonthlyBudget(store, user.userId, budgetInput({ limitAmount: '1' }), now);
    const report = await getLedgerReport(store, user.userId, {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(report.current.totals[0]?.expenses).toBe('100009999999899.99');
    const budgets = await listMonthlyBudgets(store, user.userId, { month: '2026-10' });
    expect(budgets.budgets[0]).toMatchObject({
      spentAmount: '100009999999899.99',
      remainingAmount: '-100009999999898.99',
      overBudget: true,
    });
  });
});

describe('monthly category budgets and approved defaults', () => {
  it('counts only the selected owner, month, category, and currency; separates unverified charges and preserves archive/history', async () => {
    const { env, store, user, create } = await account();
    const budget = await setMonthlyBudget(
      store,
      user.userId,
      budgetInput({ category: 'entertainment', limitAmount: '100' }),
      now,
    );
    await create({ description: 'Cinema', amount: '10', category: 'entertainment' });
    await create({
      description: 'Income ignored',
      type: 'income',
      amount: '500',
      category: 'entertainment',
    });
    await create({
      description: 'Other currency',
      amount: '40',
      currency: 'USD',
      category: 'entertainment',
    });
    await create({
      description: 'Outside month',
      amount: '20',
      date: '2026-09-30',
      category: 'entertainment',
    });
    const other = await principal(env);
    await createExpense(
      store,
      other.userId,
      createExpenseSchema.parse(expenseInput({ category: 'entertainment', amount: '1000' })),
      now,
    );
    const schedule = await createRecurring(
      store,
      user.userId,
      { ...scheduleInput(), automatic: true },
      now,
    );
    await recordAutomaticOccurrence(store, user.userId, schedule.id, now);
    const result = await listMonthlyBudgets(store, user.userId, { month: '2026-10' });
    expect(result.budgets[0]).toMatchObject({
      spentAmount: '209.00',
      confirmedSpentAmount: '10.00',
      unverifiedAmount: '199.00',
      remainingAmount: '-109.00',
      overBudget: true,
      count: 2,
    });
    expect((await listMonthlyBudgets(store, other.userId, { month: '2026-10' })).budgets).toEqual(
      [],
    );
    await setMonthlyBudget(
      store,
      user.userId,
      budgetInput({ category: 'entertainment', active: false, expectedVersion: budget.version }),
      now,
    );
    expect((await listMonthlyBudgets(store, user.userId, { month: '2026-10' })).budgets).toEqual(
      [],
    );
    expect(
      (await listMonthlyBudgets(store, user.userId, { month: '2026-10', includeInactive: true }))
        .budgets,
    ).toHaveLength(1);
    const history = await getActivityHistory(store, user.userId, {
      kind: 'budget',
      entityId: budget.id,
    });
    expect(history.activity.map((item) => item.version)).toEqual([1, 2]);
    expect(history.activity[1]?.before).toMatchObject({ limitAmount: '100.00', active: true });
  });

  it('honors leap-day/month edges and updates/deletions immediately in budget spending', async () => {
    const { store, user, create } = await account();
    await setMonthlyBudget(
      store,
      user.userId,
      budgetInput({ month: '2024-02', limitAmount: '1' }),
      now,
    );
    const expense = await create({ description: 'Leap day', date: '2024-02-29', amount: '0.30' });
    await create({ description: 'Next month', date: '2024-03-01', amount: '99' });
    expect(
      (await listMonthlyBudgets(store, user.userId, { month: '2024-02' })).budgets[0]?.spentAmount,
    ).toBe('0.30');
    const updated = await updateExpense(
      store,
      user.userId,
      { ...deletion(expense), changes: { amount: '1.20' } },
      now,
    );
    expect(
      (await listMonthlyBudgets(store, user.userId, { month: '2024-02' })).budgets[0]
        ?.remainingAmount,
    ).toBe('-0.20');
    await deleteExpense(store, user.userId, deletion(updated), now);
    expect(
      (await listMonthlyBudgets(store, user.userId, { month: '2024-02' })).budgets[0]?.spentAmount,
    ).toBe('0.00');
  });

  it('serializes budget retries and conflicting versions, retains original receipts, and rejects changed-key input', async () => {
    const { store, user, env } = await account();
    const input = budgetInput();
    const [a, b] = await Promise.all([
      setMonthlyBudget(store, user.userId, input, now),
      setMonthlyBudget(store, user.userId, input, now),
    ]);
    expect(a).toEqual(b);
    const outcomes = await Promise.allSettled(
      ['600', '700'].map((limitAmount) =>
        setMonthlyBudget(store, user.userId, budgetInput({ expectedVersion: 1, limitAmount }), now),
      ),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT' },
    });
    expect(await setMonthlyBudget(store, user.userId, input, now)).toEqual(a);
    await expect(
      setMonthlyBudget(store, user.userId, { ...input, limitAmount: '999' }, now),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(
      await env.DB.prepare('SELECT COUNT(*) n FROM account_mutations WHERE owner_id = ?')
        .bind(user.userId)
        .first('n'),
    ).toBe(2);
    expect(setBudgetSchema.safeParse({ ...input, month: '2026-13' }).success).toBe(false);
  });

  it('rolls back configuration with its receipt on failures and enforces database constraints', async () => {
    const { store, user, env } = await account();
    await env.DB.exec(
      "CREATE TRIGGER synthetic_account_failure BEFORE INSERT ON account_mutations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    try {
      await expect(setMonthlyBudget(store, user.userId, budgetInput(), now)).rejects.toThrow();
      await expect(
        setPreferences(store, user.userId, { defaultCurrency: 'MXN', idempotencyKey: key() }, now),
      ).rejects.toThrow();
    } finally {
      await env.DB.exec('DROP TRIGGER synthetic_account_failure');
    }
    await env.DB.exec(
      "CREATE TRIGGER synthetic_budget_state_failure BEFORE INSERT ON monthly_budgets BEGIN SELECT RAISE(ABORT, 'synthetic state failure'); END",
    );
    await env.DB.exec(
      "CREATE TRIGGER synthetic_preferences_state_failure BEFORE INSERT ON user_preferences BEGIN SELECT RAISE(ABORT, 'synthetic state failure'); END",
    );
    try {
      await expect(setMonthlyBudget(store, user.userId, budgetInput(), now)).rejects.toThrow();
      await expect(
        setPreferences(store, user.userId, { defaultCurrency: 'MXN', idempotencyKey: key() }, now),
      ).rejects.toThrow();
      expect(
        await env.DB.prepare('SELECT COUNT(*) n FROM account_mutations WHERE owner_id = ?')
          .bind(user.userId)
          .first('n'),
      ).toBe(0);
    } finally {
      await env.DB.exec('DROP TRIGGER synthetic_budget_state_failure');
      await env.DB.exec('DROP TRIGGER synthetic_preferences_state_failure');
    }
    expect((await listMonthlyBudgets(store, user.userId, { month: '2026-10' })).budgets).toEqual(
      [],
    );
    expect((await getPreferences(store, user.userId)).version).toBe(0);
    const budget = await setMonthlyBudget(store, user.userId, budgetInput(), now);
    await expect(
      env.DB.prepare('UPDATE monthly_budgets SET amount_minor = -1 WHERE id = ?')
        .bind(budget.id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("UPDATE monthly_budgets SET month = '2026-99' WHERE id = ?")
        .bind(budget.id)
        .run(),
    ).rejects.toThrow();
  });

  it('persists only approved defaults across connections, clears them, scopes them to owners, and replays the original change', async () => {
    const { store, user, env, client } = await account();
    expect(await getPreferences(store, user.userId)).toEqual({
      defaultCurrency: null,
      version: 0,
      timezone: 'America/Mexico_City',
    });
    const input = { defaultCurrency: 'MXN' as const, expectedVersion: 0, idempotencyKey: key() };
    const response = await client.callTool({ name: 'set_preferences', arguments: input });
    expect(response.isError).not.toBe(true);
    const fresh = await connect(env, user.token);
    clients.push(fresh);
    expect(
      (await fresh.callTool({ name: 'get_preferences', arguments: {} })).structuredContent,
    ).toMatchObject({ defaultCurrency: 'MXN', version: 1 });
    await setPreferences(
      store,
      user.userId,
      { defaultCurrency: null, expectedVersion: 1, idempotencyKey: key() },
      now,
    );
    expect((await getPreferences(store, user.userId)).defaultCurrency).toBeNull();
    expect((await setPreferences(store, user.userId, input, now)).defaultCurrency).toBe('MXN');
    await expect(
      setPreferences(store, user.userId, { ...input, defaultCurrency: 'USD' }, now),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const other = await principal(env);
    expect((await getPreferences(store, other.userId)).defaultCurrency).toBeNull();
    await expect(
      setPreferences(store, other.userId, { ...input, expectedVersion: 1 }, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (
        await client.callTool({
          name: 'set_preferences',
          arguments: { ...input, userId: other.userId },
        })
      ).isError,
    ).toBe(true);
  });
});

describe('audited recovery and activity', () => {
  it('requires distinguishing user facts when multiple deleted entries match', async () => {
    const { store, user, create } = await account();
    const first = await create({ date: '2026-10-01' });
    const deleted = await deleteExpense(store, user.userId, deletion(first), now);
    const second = await create({ date: '2026-10-02' });
    await deleteExpense(store, user.userId, deletion(second), now);
    const input = {
      entryId: first.id,
      expectedVersion: deleted.version,
      match: { description: first.description },
      idempotencyKey: key(),
    };
    await expect(restoreEntry(store, user.userId, input, now)).rejects.toMatchObject({
      code: 'AMBIGUOUS_TARGET',
    });
    const restored = await restoreEntry(
      store,
      user.userId,
      { ...input, match: { description: first.description, date: first.date } },
      now,
    );
    expect(restored.id).toBe(first.id);
  });
  it('lists and restores a deleted entry once, preserves hash history, and replays after later edits', async () => {
    const { store, user, env, create, client } = await account();
    const entry = await create();
    const deleted = await deleteExpense(store, user.userId, deletion(entry), now);
    expect((await listExpenses(store, user.userId, {})).expenses).toEqual([]);
    expect(
      (await listExpenses(store, user.userId, { deleted: 'only', query: 'gasolina' })).expenses[0]
        ?.id,
    ).toBe(entry.id);
    const input = {
      entryId: entry.id,
      expectedVersion: deleted.version,
      match: { description: entry.description },
      idempotencyKey: key(),
    };
    const [a, b] = await Promise.all([
      restoreEntry(store, user.userId, input, now),
      restoreEntry(store, user.userId, input, now),
    ]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ version: 3, deletedAt: null });
    await updateExpense(store, user.userId, { ...deletion(a), changes: { amount: '405' } }, now);
    expect(await restoreEntry(store, user.userId, input, now)).toEqual(a);
    expect((await store.findExpense(user.userId, entry.id))?.version).toBe(4);
    expect(await verifyAuditChain(env.DB, user.userId)).toEqual({ valid: true, checked: 4 });
    const history = await client.callTool({
      name: 'get_activity_history',
      arguments: { kind: 'entry', entityId: entry.id, limit: 2 },
    });
    expect(history.structuredContent).toMatchObject({
      activity: [{ version: 1 }, { version: 2, details: { operation: 'delete' } }],
      nextAfterVersion: 2,
    });
    const page = await getActivityHistory(store, user.userId, {
      kind: 'entry',
      entityId: entry.id,
      afterVersion: 2,
    });
    expect(page.activity.map((item) => item.version)).toEqual([3, 4]);
    expect(page.activity[0]?.details.operation).toBe('restore');
  });

  it('requires unique user facts and current versions; duplicate warnings and a racing candidate cannot silently restore', async () => {
    const { store, user, create, env } = await account();
    const entry = await create();
    const deleted = await deleteExpense(store, user.userId, deletion(entry), now);
    const candidate = await create();
    const input = {
      entryId: entry.id,
      expectedVersion: deleted.version,
      match: { description: entry.description },
      idempotencyKey: key(),
    };
    await expect(restoreEntry(store, user.userId, input, now)).rejects.toMatchObject({
      code: 'POSSIBLE_DUPLICATE',
    });
    expect((await store.findExpense(user.userId, entry.id))?.deletedAt).not.toBeNull();
    const restored = await restoreEntry(
      store,
      user.userId,
      { ...input, duplicateConfirmation: [{ id: candidate.id, version: candidate.version }] },
      now,
    );
    expect(restored.deletedAt).toBeNull();
    await expect(
      restoreEntry(store, user.userId, { ...input, idempotencyKey: key() }, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const other = await principal(env);
    await expect(restoreEntry(store, other.userId, input, now)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      (await getActivityHistory(store, other.userId, { kind: 'entry', entityId: entry.id }))
        .activity,
    ).toEqual([]);

    const clean = await create({ description: 'Restore race', amount: '10' });
    const removed = await deleteExpense(store, user.userId, deletion(clean), now);
    const racingStore = {
      ...store,
      commit: async (mutation: Parameters<typeof store.commit>[0]) => {
        await create({ description: clean.description, amount: clean.amount });
        await store.commit(mutation);
      },
    };
    await expect(
      restoreEntry(
        racingStore,
        user.userId,
        {
          entryId: clean.id,
          expectedVersion: removed.version,
          match: { description: clean.description },
          idempotencyKey: key(),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'POSSIBLE_DUPLICATE' });
    expect((await store.findExpense(user.userId, clean.id))?.version).toBe(2);
  });

  it('restores a linked payment without advancing its schedule and exposes savings contribution history', async () => {
    const { store, user } = await account();
    const schedule = await createRecurring(store, user.userId, scheduleInput(), now);
    const payment = await confirmRecurring(
      store,
      user.userId,
      {
        recurringId: schedule.id,
        expectedVersion: 1,
        occurrenceDate: schedule.nextDate,
        paidDate: schedule.nextDate,
        amount: schedule.amount,
        idempotencyKey: key(),
      },
      now,
    );
    const beforeSchedule = await store.findRecurring(user.userId, schedule.id);
    const deleted = await deleteExpense(store, user.userId, deletion(payment), now);
    await restoreEntry(
      store,
      user.userId,
      {
        entryId: payment.id,
        expectedVersion: deleted.version,
        match: { description: payment.description },
        idempotencyKey: key(),
      },
      now,
    );
    expect(await store.findRecurring(user.userId, schedule.id)).toEqual(beforeSchedule);
    const goal = await createGoal(
      store,
      user.userId,
      { name: 'Emergency', currency: 'MXN', targetAmount: '1000', idempotencyKey: key() },
      now,
    );
    await contributeToGoal(
      store,
      user.userId,
      {
        goalId: goal.id,
        expectedVersion: 1,
        direction: 'deposit',
        amount: '0.30',
        date: '2026-10-01',
        note: 'Synthetic allocation',
        idempotencyKey: key(),
      },
      now,
    );
    const history = await getActivityHistory(store, user.userId, {
      kind: 'goal',
      entityId: goal.id,
    });
    expect(history.activity[1]?.details).toMatchObject({
      operation: 'contribution',
      amount: '0.30',
      note: 'Synthetic allocation',
    });
  });
});

describe('bounded exports and discovery boundaries', () => {
  it('executes budgets, restore, and complete-backup tools through authenticated MCP connections', async () => {
    const { client, env, user, create } = await account();
    const saved = await client.callTool({
      name: 'set_monthly_budget',
      arguments: budgetInput({ limitAmount: '1' }),
    });
    expect(saved.isError).not.toBe(true);
    expect(z.object({ budget: budgetSchema }).parse(saved.structuredContent).budget.version).toBe(
      1,
    );
    const expense = await create({ amount: '0.30' });
    expect(
      (await client.callTool({ name: 'list_monthly_budgets', arguments: { month: '2026-10' } }))
        .structuredContent,
    ).toMatchObject({ budgets: [{ spentAmount: '0.30', remainingAmount: '0.70' }] });
    const deleted = await client.callTool({
      name: 'delete_entry',
      arguments: {
        entryId: expense.id,
        expectedVersion: 1,
        match: { description: expense.description },
        idempotencyKey: key(),
      },
    });
    expect(deleted.isError).not.toBe(true);
    const fresh = await connect(env, user.token);
    clients.push(fresh);
    const restored = await fresh.callTool({
      name: 'restore_entry',
      arguments: {
        entryId: expense.id,
        expectedVersion: 2,
        match: { description: expense.description },
        idempotencyKey: key(),
      },
    });
    expect(restored.isError).not.toBe(true);
    expect(restored.structuredContent).toMatchObject({ entry: { version: 3, deletedAt: null } });
    const backup = await fresh.callTool({
      name: 'export_backup',
      arguments: { dataset: 'entry_history', limit: 1 },
    });
    expect(backup.isError).not.toBe(true);
    expect(backup.structuredContent).toMatchObject({
      count: 1,
      nextCursor: expect.any(String),
      consistency: 'live',
    });
    expect(
      (await fresh.callTool({ name: 'export_backup', arguments: { dataset: 'entries' } })).isError,
    ).not.toBe(true);
  });
  it('paginates expenses before filtering, includes deletions, and generates escaped CSV without formulas', async () => {
    const { store, user, client, create } = await account();
    const first = await create({ description: '=SUM(1,2)\n"quoted"', amount: '0.10' });
    await create({ type: 'income', description: 'Hidden income' });
    const second = await create({ description: 'Second expense', amount: '0.20' });
    await deleteExpense(store, user.userId, deletion(second), now);
    const a = await exportEntryPage(store, user.userId, { limit: 1 }, 'expense', now);
    const b = await exportEntryPage(
      store,
      user.userId,
      { limit: 1, cursor: a.nextCursor ?? undefined },
      'expense',
      now,
    );
    expect([...(a.entries ?? []), ...(b.entries ?? [])].map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(b.nextCursor).toBeNull();
    expect([...(a.entries ?? []), ...(b.entries ?? [])].some((entry) => entry.deletedAt)).toBe(
      true,
    );
    const csv = await client.callTool({ name: 'export_expenses', arguments: { format: 'csv' } });
    expect(csv.isError).not.toBe(true);
    const text = z.object({ csv: z.string() }).parse(csv.structuredContent).csv;
    expect(text).toContain('"\'=SUM(1,2)\n""quoted"""');
    expect(text).not.toContain('Hidden income');
    await expect(
      exportEntryPage(store, user.userId, { cursor: a.nextCursor ?? undefined }, undefined, now),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      (await client.callTool({ name: 'export_entries', arguments: { limit: 101 } })).isError,
    ).toBe(true);
  });

  it('backs up every financial dataset with bounded owner-only pages and original audit receipts', async () => {
    const { store, user, env, create } = await account();
    const other = await principal(env);
    await create();
    await createExpense(
      store,
      other.userId,
      createExpenseSchema.parse(expenseInput({ description: 'PRIVATE other ledger' })),
      now,
    );
    await createRecurring(store, user.userId, scheduleInput(), now);
    await createGoal(
      store,
      user.userId,
      { name: 'My goal', currency: 'MXN', targetAmount: '10', idempotencyKey: key() },
      now,
    );
    await createGoal(
      store,
      other.userId,
      { name: 'PRIVATE other goal', currency: 'MXN', targetAmount: '10', idempotencyKey: key() },
      now,
    );
    await setMonthlyBudget(store, user.userId, budgetInput(), now);
    await setPreferences(
      store,
      user.userId,
      { defaultCurrency: 'MXN', idempotencyKey: key() },
      now,
    );
    let cursorFromHistory: string | undefined;
    for (const dataset of backupDatasetSchema.options) {
      const records: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      do {
        const page = await exportBackup(store, user.userId, { dataset, limit: 1, cursor }, now);
        expect(page.count).toBeLessThanOrEqual(1);
        records.push(...page.records);
        cursor = page.nextCursor ?? undefined;
        if (dataset === 'planning_history' && cursor) cursorFromHistory = cursor;
      } while (cursor);
      expect(records.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(records);
      expect(serialized).not.toContain('PRIVATE');
      expect(serialized).not.toContain('ownerId');
      expect(serialized).not.toContain('googleSubject');
      if (dataset === 'entry_history')
        expect(records[0]).toMatchObject({
          version: 1,
          entryHash: expect.any(String),
          hash: expect.any(String),
        });
    }
    expect(cursorFromHistory).toBeDefined();
    await expect(
      exportBackup(store, user.userId, { dataset: 'goals', cursor: cursorFromHistory }, now),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('orders recurring pages by due date and uses the export index without a temporary sort', async () => {
    const { store, user, env } = await account();
    for (const date of ['2026-12-01', '2026-10-01', '2026-11-01'])
      await createRecurring(store, user.userId, scheduleInput(date), now);
    const a = await listRecurring(store, user.userId, { limit: 1 }, now);
    const b = await listRecurring(
      store,
      user.userId,
      { limit: 1, afterId: a.nextAfterId ?? undefined, afterDate: a.nextAfterDate ?? undefined },
      now,
    );
    const c = await listRecurring(
      store,
      user.userId,
      { limit: 1, afterId: b.nextAfterId ?? undefined, afterDate: b.nextAfterDate ?? undefined },
      now,
    );
    expect([a, b, c].map((page) => page.recurring[0]?.nextDate)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
    ]);
    const plan = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM expenses WHERE owner_id = ? ORDER BY created_at, id LIMIT 101',
    )
      .bind(user.userId)
      .all<{ detail: string }>();
    expect(plan.results.some((row) => row.detail.includes('expense_owner_created_id'))).toBe(true);
    expect(plan.results.some((row) => row.detail.includes('TEMP B-TREE'))).toBe(false);
    const continuation = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT * FROM expenses WHERE owner_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT 101',
    )
      .bind(user.userId, now.toISOString(), key())
      .all<{ detail: string }>();
    expect(
      continuation.results.some(
        (row) => row.detail.includes('expense_owner_created_id') && row.detail.includes('>'),
      ),
    ).toBe(true);
  });

  it('denies every new tool to legacy-only grants and every new mutation to read-only grants', async () => {
    const readOnly = await account(['ledger:read']);
    const legacy = await account(['expenses:read', 'expenses:write']);
    const mutations = [
      { name: 'set_preferences', arguments: { defaultCurrency: 'MXN', idempotencyKey: key() } },
      { name: 'set_monthly_budget', arguments: budgetInput() },
      {
        name: 'restore_entry',
        arguments: {
          entryId: key(),
          expectedVersion: 1,
          match: { description: 'Missing' },
          idempotencyKey: key(),
        },
      },
    ];
    for (const call of mutations)
      expect((await readOnly.client.callTool(call)).structuredContent).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    for (const call of [
      ...mutations,
      { name: 'get_preferences', arguments: {} },
      { name: 'list_monthly_budgets', arguments: { month: '2026-10' } },
      { name: 'get_ledger_report', arguments: { from: '2026-10-01', to: '2026-10-31' } },
      { name: 'get_activity_history', arguments: { kind: 'goal', entityId: key() } },
      { name: 'export_backup', arguments: {} },
    ])
      expect((await legacy.client.callTool(call)).structuredContent).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    expect((await readOnly.client.listTools()).tools).toHaveLength(30);
    const created = await readOnly.create();
    const foreignHistory = await legacy.client.callTool({
      name: 'get_activity_history',
      arguments: { kind: 'entry', entityId: created.id },
    });
    expect(foreignHistory.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const budget = await readOnly.client.callTool({
      name: 'set_monthly_budget',
      arguments: { ...budgetInput(), ownerId: legacy.user.userId },
    });
    expect(budget.isError).toBe(true);
    expect(budgetSchema.safeParse({ month: '2026-13' }).success).toBe(false);
  });
});
