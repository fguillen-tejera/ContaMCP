import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { ledgerStore } from '../src/db/ledger';
import { requestHash } from '../src/domain/mutation';
import { createExpenseSchema } from '../src/domain/expense';
import { createExpense } from '../src/expenses/service';

it('upgrades a populated pre-income database without changing ledger records or audit snapshots', async () => {
  for (const table of [
    'account_mutations',
    'monthly_budgets',
    'user_preferences',
    'planning_mutations',
    'recurring_entries',
    'savings_goals',
    'expense_mutations',
    'expenses',
    'users',
  ]) {
    await env.DB.exec(`DROP TABLE ${table}`);
  }
  const previous = env.TEST_MIGRATIONS.filter((migration) => migration.name < '0004');
  const latest = env.TEST_MIGRATIONS.filter((migration) => migration.name >= '0004');
  await applyD1Migrations(env.DB, previous, 'upgrade_test_migrations');
  const owner = crypto.randomUUID();
  const id = crypto.randomUUID();
  const snapshot = JSON.stringify({
    id,
    description: 'SYNTHETIC existing expense',
    amount: '450.00',
    amountMinor: '45000',
    currency: 'MXN',
    date: '2026-10-23',
    category: 'transport',
    version: 1,
    deletedAt: null,
    createdAt: '2026-10-23T12:00:00.000Z',
    updatedAt: '2026-10-23T12:00:00.000Z',
  });
  const originalInput = {
    description: 'SYNTHETIC existing expense',
    amount: '450.00',
    currency: 'MXN',
    date: '2026-10-23',
    category: 'transport',
    idempotencyKey: 'synthetic-existing-key',
  };
  const hash = await requestHash('create', originalInput);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, google_subject, created_at) VALUES (?, ?, ?)').bind(
      owner,
      'synthetic-upgrade-subject',
      '2026-10-23T12:00:00.000Z',
    ),
    env.DB.prepare(
      'INSERT INTO expenses (id, owner_id, description, amount_minor, currency, date, category, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      id,
      owner,
      'SYNTHETIC existing expense',
      45000,
      'MXN',
      '2026-10-23',
      'transport',
      1,
      '2026-10-23T12:00:00.000Z',
      '2026-10-23T12:00:00.000Z',
    ),
    env.DB.prepare(
      'INSERT INTO expense_mutations (owner_id, idempotency_key, request_hash, expense_id, version, after_json, entry_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      owner,
      'synthetic-existing-key',
      hash,
      id,
      1,
      snapshot,
      'synthetic-entry-hash',
      '2026-10-23T12:00:00.000Z',
    ),
  ]);
  const audit = await env.DB.prepare('SELECT * FROM expense_mutations').all();
  await applyD1Migrations(env.DB, latest, 'upgrade_test_migrations');
  expect(
    await env.DB.prepare(
      'SELECT type, recurring_id, occurrence_date, amount_minor FROM expenses WHERE id = ?',
    )
      .bind(id)
      .first(),
  ).toEqual({ type: 'expense', recurring_id: null, occurrence_date: null, amount_minor: 45000 });
  expect((await env.DB.prepare('SELECT * FROM expense_mutations').all()).results).toEqual(
    audit.results,
  );
  expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  const replayed = await createExpense(
    ledgerStore(env.DB),
    owner,
    createExpenseSchema.parse(originalInput),
  );
  expect(replayed).toMatchObject({
    id,
    type: 'expense',
    recurringId: null,
    occurrenceDate: null,
    version: 1,
  });
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(1);
  const income = await createExpense(
    ledgerStore(env.DB),
    owner,
    createExpenseSchema.parse({
      type: 'income',
      description: 'Synthetic salary',
      amount: '1000',
      currency: 'MXN',
      date: '2026-10-23',
      category: 'other',
      idempotencyKey: crypto.randomUUID(),
    }),
  );
  expect(income.type).toBe('income');
  await applyD1Migrations(env.DB, latest, 'upgrade_test_migrations');
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(2);
});
