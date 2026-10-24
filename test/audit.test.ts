import { describe, expect, it } from 'vitest';
import { ledgerStore, verifyAuditChain } from '../src/db/ledger';
import { createExpenseSchema } from '../src/domain/expense';
import { createExpense, updateExpense } from '../src/expenses/service';
import { bindings, expenseInput, principal } from './helpers';

async function correctedEntry() {
  const env = bindings();
  const user = await principal(env);
  const store = ledgerStore(env.DB);
  const entry = await createExpense(store, user.userId, createExpenseSchema.parse(expenseInput()));
  await updateExpense(store, user.userId, {
    expenseId: entry.id,
    expectedVersion: 1,
    match: { description: entry.description },
    changes: { amount: '451.00' },
    idempotencyKey: crypto.randomUUID(),
  });
  return { env, user, entry };
}

describe('audit integrity', () => {
  it('preserves hashes of legacy snapshots while comparing newer schema defaults', async () => {
    const env = bindings();
    const user = await principal(env);
    const legacy = {
      id: '00000000-0000-4000-8000-000000000001',
      description: 'SYNTHETIC legacy audit',
      amount: '450.00',
      amountMinor: '45000',
      currency: 'MXN',
      date: '2026-10-23',
      category: 'transport',
      version: 1,
      deletedAt: null,
      createdAt: '2026-10-23T12:00:00.000Z',
      updatedAt: '2026-10-23T12:00:00.000Z',
    };
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO expenses (id, owner_id, description, amount_minor, currency, date, category, version, created_at, updated_at) VALUES (?, ?, ?, 45000, 'MXN', '2026-10-23', 'transport', 1, ?, ?)",
      ).bind(legacy.id, user.userId, legacy.description, legacy.createdAt, legacy.updatedAt),
      env.DB.prepare(
        'INSERT INTO expense_mutations (owner_id, idempotency_key, request_hash, expense_id, version, after_json, entry_hash, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
      ).bind(
        user.userId,
        'legacy-create-01',
        'synthetic-request-hash',
        legacy.id,
        JSON.stringify(legacy),
        '1ebb72ae4e9a149b30fc007ab9231fac84ff3e05c8bd72ef64ecea74ed1933bc',
        legacy.updatedAt,
      ),
    ]);
    expect(await verifyAuditChain(env.DB, user.userId)).toEqual({ valid: true, checked: 1 });
    await updateExpense(ledgerStore(env.DB), user.userId, {
      expenseId: legacy.id,
      expectedVersion: 1,
      match: { description: legacy.description },
      changes: { amount: '451.00' },
      idempotencyKey: crypto.randomUUID(),
    });
    expect(await verifyAuditChain(env.DB, user.userId)).toEqual({ valid: true, checked: 2 });
  });

  it.each([1, 2, null])('rejects missing receipts at version %s', async (version) => {
    const { env, user, entry } = await correctedEntry();
    await env.DB.prepare(
      'DELETE FROM expense_mutations WHERE owner_id = ? AND expense_id = ? AND (? IS NULL OR version = ?)',
    )
      .bind(user.userId, entry.id, version, version)
      .run();
    expect(await verifyAuditChain(env.DB, user.userId)).toMatchObject({
      valid: false,
      expenseId: entry.id,
    });
  });

  it('never reports an unhashed history as verified', async () => {
    const { env, user, entry } = await correctedEntry();
    await env.DB.prepare(
      'UPDATE expense_mutations SET entry_hash = NULL, prev_hash = NULL WHERE owner_id = ?',
    )
      .bind(user.userId)
      .run();
    expect(await verifyAuditChain(env.DB, user.userId)).toMatchObject({
      valid: false,
      expenseId: entry.id,
    });
  });

  it('compares the latest receipt with the stored entry', async () => {
    const { env, user, entry } = await correctedEntry();
    await env.DB.prepare('UPDATE expenses SET amount_minor = 999 WHERE owner_id = ? AND id = ?')
      .bind(user.userId, entry.id)
      .run();
    expect(await verifyAuditChain(env.DB, user.userId)).toMatchObject({
      valid: false,
      expenseId: entry.id,
    });
  });

  it('verifies only the requested owner, including an empty ledger', async () => {
    const { env, user, entry } = await correctedEntry();
    const other = await principal(env);
    await env.DB.prepare('DELETE FROM expense_mutations WHERE owner_id = ? AND expense_id = ?')
      .bind(user.userId, entry.id)
      .run();
    expect(await verifyAuditChain(env.DB, other.userId)).toEqual({ valid: true, checked: 0 });
    expect(await verifyAuditChain(env.DB, user.userId)).toMatchObject({ valid: false });
  });
});
