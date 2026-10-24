import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ledgerStore } from '../src/db/ledger';
import { createExpenseSchema, todayInMexico } from '../src/domain/expense';
import { createExpense } from '../src/expenses/service';
import { bindings, expenseInput, principal } from './helpers';

describe('financial and persistence invariants', () => {
  it('uses the Mexico City calendar day and replays defaults across midnight', async () => {
    expect(todayInMexico(new Date('2026-10-24T05:59:59Z'))).toBe('2026-10-23');
    const user = await principal(bindings());
    const input = createExpenseSchema.parse({ ...expenseInput(), date: undefined });
    const store = ledgerStore(env.DB);
    const beforeMidnight = await createExpense(
      store,
      user.userId,
      input,
      new Date('2026-10-24T05:59:59Z'),
    );
    const afterMidnight = await createExpense(
      store,
      user.userId,
      input,
      new Date('2026-10-24T06:01:00Z'),
    );
    expect(beforeMidnight.date).toBe('2026-10-23');
    expect(afterMidnight).toEqual(beforeMidnight);
  });

  it('rolls back the expense if writing its audit entry fails', async () => {
    const user = await principal(bindings());
    await env.DB.exec(
      `CREATE TRIGGER fail_audit BEFORE INSERT ON expense_mutations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    );
    try {
      await expect(
        createExpense(ledgerStore(env.DB), user.userId, createExpenseSchema.parse(expenseInput())),
      ).rejects.toThrow();
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expenses').first('n')).toBe(0);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM expense_mutations').first('n')).toBe(
        0,
      );
    } finally {
      await env.DB.exec('DROP TRIGGER fail_audit');
    }
  });

  it('enforces exact amount, currency, date, category, and ownership constraints in SQLite', async () => {
    const user = await principal(bindings());
    for (const [amount, currency, date, category, owner] of [
      [0, 'MXN', '2026-10-23', null, user.userId],
      [1.5, 'MXN', '2026-10-23', null, user.userId],
      [1, 'JPY', '2026-10-23', null, user.userId],
      [1, 'MXN', '2026-02-30', null, user.userId],
      [1, 'MXN', '2026-10-23', 'invented', user.userId],
      [1, 'MXN', '2026-10-23', null, user.userId],
      [1, 'MXN', '2026-10-23', null, 'missing-user'],
    ] as const) {
      await expect(
        env.DB.prepare(`INSERT INTO expenses (id, owner_id, description, amount_minor, currency, date, category, version, created_at, updated_at)
        VALUES (?, ?, 'Synthetic', ?, ?, ?, ?, 1, '2026-10-23T00:00:00Z', '2026-10-23T00:00:00Z')`)
          .bind(crypto.randomUUID(), owner, amount, currency, date, category)
          .run(),
      ).rejects.toThrow();
    }
  });
});
