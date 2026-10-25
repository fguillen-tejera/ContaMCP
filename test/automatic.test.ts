import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { z } from 'zod';
import { ledgerStore, verifyAuditChain } from '../src/db/ledger';
import { automaticRecordingOwners, publicAutomaticRecordingOwners } from '../src/db/automatic';
import { createExpenseSchema, expenseSchema, todayInMexico } from '../src/domain/expense';
import { requestHash } from '../src/domain/mutation';
import { recurringSchema } from '../src/domain/planning';
import {
  createExpense,
  deleteExpense,
  getCashFlow,
  getExpenseSummary,
} from '../src/expenses/service';
import { recordAutomaticOccurrence, recordDueOccurrences } from '../src/planning/automatic';
import {
  cancelRecurring,
  confirmRecurring,
  createRecurring,
  skipRecurring,
  updateRecurring,
} from '../src/planning/recurring';
import worker from '../src/index';
import { bindings, connect, dispatch, expenseInput, principal } from './helpers';

const now = new Date('2026-10-24T06:05:00Z');
const key = () => crypto.randomUUID();
const input = (overrides: Record<string, unknown> = {}) => ({
  description: 'SYNTHETIC Netflix',
  type: 'expense' as const,
  amount: '199',
  currency: 'MXN' as const,
  category: 'entertainment' as const,
  interval: 'monthly' as const,
  firstDate: '2026-10-24',
  idempotencyKey: key(),
  ...overrides,
});
async function account() {
  const env = bindings();
  const user = await principal(env);
  const store = ledgerStore(env.DB);
  return { env, user, store };
}
afterEach(() => {
  vi.restoreAllMocks();
});

describe('automatic recurring recording', () => {
  it('selects only eligible public schedules at the Mexico City date boundary', async () => {
    const { env, user, store } = await account();
    await createRecurring(store, user.userId, input(), now);
    const other = await principal(env);
    await createRecurring(store, other.userId, input({ automatic: false }), now);
    await createRecurring(store, other.userId, input({ firstDate: '2026-10-25' }), now);
    const paused = await createRecurring(store, other.userId, input(), now);
    await cancelRecurring(
      store,
      other.userId,
      {
        recurringId: paused.id,
        expectedVersion: 1,
        idempotencyKey: key(),
      },
      now,
    );
    expect(await publicAutomaticRecordingOwners(env.DB, new Date('2026-10-24T05:59:59Z'))).toEqual(
      [],
    );
    expect(await publicAutomaticRecordingOwners(env.DB, now)).toEqual([user.userId]);
    const query = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT owner_id FROM recurring_entries
      WHERE json_extract(data, '$.active') = 1 AND json_extract(data, '$.automatic') = 1
      AND COALESCE(json_extract(data, '$.needsReview'), 0) = 0
      AND json_extract(data, '$.nextDate') <= ? ORDER BY json_extract(data, '$.nextDate'), id LIMIT 5`)
      .bind('2026-10-24')
      .all<{ detail: string }>();
    expect(query.results.some((row) => row.detail.includes('recurring_automatic_due'))).toBe(true);
  });
  it('reuses calendar formatting without caching the date across midnight or year boundaries', () => {
    expect(
      [
        '2026-10-24T05:59:59Z',
        '2026-10-24T06:00:00Z',
        '2027-01-01T05:59:59Z',
        '2027-01-01T06:00:00Z',
        '2024-03-01T05:59:59Z',
        '2026-10-24T05:59:59Z',
      ].map((instant) => todayInMexico(new Date(instant))),
    ).toEqual(['2026-10-23', '2026-10-24', '2026-12-31', '2027-01-01', '2024-02-29', '2026-10-23']);
  });

  it('defaults new schedules to automatic and records exactly once at the Mexico City billing date', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    expect(schedule.automatic).toBe(true);
    const beforeMidnight = await recordDueOccurrences(
      store,
      [user.userId],
      new Date('2026-10-24T05:59:59Z'),
    );
    expect(beforeMidnight.recorded).toBe(0);
    expect(await recordDueOccurrences(store, [user.userId], now)).toEqual({
      recorded: 1,
      needsReview: 0,
      deferred: 0,
      failed: 0,
    });
    expect((await recordDueOccurrences(store, [user.userId], now)).recorded).toBe(0);
    const entry = await store.findOccurrence(user.userId, schedule.id, '2026-10-24');
    expect(entry).toMatchObject({
      date: '2026-10-24',
      amount: '199.00',
      source: 'recurring',
      paymentStatus: 'unverified',
      version: 1,
    });
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      nextDate: '2026-11-24',
      version: 2,
    });
    expect(await getExpenseSummary(store, user.userId, {})).toMatchObject({
      totals: [{ amount: '199.00', count: 1, unverifiedCount: 1 }],
    });
    expect(await getCashFlow(store, user.userId, {})).toEqual({
      totals: [
        { currency: 'MXN', income: '0.00', expenses: '199.00', net: '-199.00', unverifiedCount: 1 },
      ],
    });
    expect(await getCashFlow(store, user.userId, { paymentStatus: 'confirmed' })).toEqual({
      totals: [],
    });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await verifyAuditChain(env.DB, user.userId)).toEqual({ valid: true, checked: 1 });
  });

  it('serializes competing jobs for the same occurrence', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const results = await Promise.allSettled([
      recordAutomaticOccurrence(store, user.userId, schedule.id, now),
      recordAutomaticOccurrence(store, user.userId, schedule.id, now),
    ]);
    const completed = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(new Set(completed.map((entry) => entry.id)).size).toBe(1);
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'CONFLICT' });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(1);
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({ version: 2 });
  });

  it('does not convert legacy/manual schedules and preserves their original creation retry receipts', async () => {
    const { store, user, env } = await account();
    const original = input();
    const manual = await createRecurring(
      store,
      user.userId,
      { ...original, automatic: false },
      now,
    );
    const { automatic: _automatic, needsReview: _review, ...legacy } = manual;
    const hash = await requestHash('createRecurring', original);
    await env.DB.batch([
      env.DB.prepare('UPDATE recurring_entries SET data = ? WHERE owner_id = ? AND id = ?').bind(
        JSON.stringify(legacy),
        user.userId,
        manual.id,
      ),
      env.DB.prepare(
        'UPDATE planning_mutations SET request_hash = ?, after_json = ? WHERE owner_id = ? AND idempotency_key = ?',
      ).bind(hash, JSON.stringify(legacy), user.userId, `user_${original.idempotencyKey}`),
    ]);
    expect(await createRecurring(store, user.userId, original, now)).toMatchObject({
      id: manual.id,
      automatic: false,
    });
    expect((await recordDueOccurrences(store, [user.userId], now)).recorded).toBe(0);
    const client = await connect(env, user.token);
    try {
      expect(
        (await client.callTool({ name: 'create_recurring_entry', arguments: original }))
          .structuredContent,
      ).toMatchObject({ recurring: { id: manual.id, automatic: false } });
    } finally {
      await client.close();
    }
    await expect(
      updateRecurring(
        store,
        user.userId,
        {
          recurringId: manual.id,
          expectedVersion: 1,
          changes: { automatic: true },
          idempotencyKey: key(),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await updateRecurring(
      store,
      user.userId,
      {
        recurringId: manual.id,
        expectedVersion: 1,
        changes: { automatic: true, nextDate: '2026-10-24' },
        idempotencyKey: key(),
      },
      now,
    );
    expect((await recordDueOccurrences(store, [user.userId], now)).recorded).toBe(1);
  });

  it('blocks possible duplicates for review without advancing or repeatedly writing audit markers', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const existing = await createExpense(
      store,
      user.userId,
      createExpenseSchema.parse(
        expenseInput({
          description: schedule.description,
          amount: schedule.amount,
          date: schedule.nextDate,
          category: schedule.category,
        }),
      ),
      now,
    );
    expect(await recordDueOccurrences(store, [user.userId], now)).toEqual({
      recorded: 0,
      needsReview: 1,
      deferred: 0,
      failed: 0,
    });
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      nextDate: '2026-10-24',
      version: 2,
      needsReview: true,
    });
    expect((await recordDueOccurrences(store, [user.userId], now)).recorded).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM planning_mutations').first('n')).toBe(2);
    await confirmRecurring(
      store,
      user.userId,
      {
        recurringId: schedule.id,
        expectedVersion: 2,
        occurrenceDate: '2026-10-24',
        paidDate: existing.date,
        amount: existing.amount,
        existingEntryId: existing.id,
        expectedEntryVersion: existing.version,
        idempotencyKey: key(),
      },
      now,
    );
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      nextDate: '2026-11-24',
      needsReview: false,
      version: 3,
    });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
  });

  it('reconciles an automatic entry in place with the actual amount/date and does not advance twice', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const entry = await recordAutomaticOccurrence(store, user.userId, schedule.id, now);
    const confirmation = {
      recurringId: schedule.id,
      expectedVersion: 2,
      occurrenceDate: '2026-10-24',
      paidDate: '2026-10-24',
      amount: '205.50',
      existingEntryId: entry.id,
      expectedEntryVersion: entry.version,
      idempotencyKey: key(),
    };
    const result = await confirmRecurring(store, user.userId, confirmation, now);
    expect(result).toMatchObject({
      id: entry.id,
      amount: '205.50',
      source: 'recurring',
      paymentStatus: 'confirmed',
      version: 2,
    });
    expect(await confirmRecurring(store, user.userId, confirmation, now)).toEqual(result);
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      version: 2,
      nextDate: '2026-11-24',
    });
    expect(await getCashFlow(store, user.userId, {})).toMatchObject({
      totals: [{ expenses: '205.50', unverifiedCount: 0 }],
    });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await verifyAuditChain(env.DB, user.userId)).toEqual({ valid: true, checked: 2 });
    await expect(
      confirmRecurring(store, user.userId, { ...confirmation, idempotencyKey: key() }, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('checks entry versions and owner isolation during reconciliation', async () => {
    const { store, user, env } = await account();
    const other = await principal(env);
    const schedule = await createRecurring(store, user.userId, input(), now);
    const entry = await recordAutomaticOccurrence(store, user.userId, schedule.id, now);
    const confirmation = {
      recurringId: schedule.id,
      expectedVersion: 2,
      occurrenceDate: entry.date,
      paidDate: entry.date,
      amount: '199',
      existingEntryId: entry.id,
      expectedEntryVersion: 2,
      idempotencyKey: key(),
    };
    await expect(confirmRecurring(store, user.userId, confirmation, now)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(confirmRecurring(store, other.userId, confirmation, now)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      recordAutomaticOccurrence(store, other.userId, schedule.id, now),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.findOccurrence(other.userId, schedule.id, entry.date)).toBeUndefined();
    expect((await store.findExpense(user.userId, entry.id))?.paymentStatus).toBe('unverified');
  });

  it('pauses, requires an explicit resume date, and applies new amounts only to future entries', async () => {
    const { store, user } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const first = await recordAutomaticOccurrence(store, user.userId, schedule.id, now);
    const paused = await updateRecurring(
      store,
      user.userId,
      {
        recurringId: schedule.id,
        expectedVersion: 2,
        changes: { active: false },
        idempotencyKey: key(),
      },
      now,
    );
    const november = new Date('2026-11-24T12:00:00Z');
    expect((await recordDueOccurrences(store, [user.userId], november)).recorded).toBe(0);
    await expect(
      updateRecurring(
        store,
        user.userId,
        {
          recurringId: schedule.id,
          expectedVersion: paused.version,
          changes: { active: true },
          idempotencyKey: key(),
        },
        november,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await updateRecurring(
      store,
      user.userId,
      {
        recurringId: schedule.id,
        expectedVersion: paused.version,
        changes: { active: true, nextDate: '2026-11-24', amount: '249' },
        idempotencyKey: key(),
      },
      november,
    );
    expect((await recordDueOccurrences(store, [user.userId], november)).recorded).toBe(1);
    expect((await store.findExpense(user.userId, first.id))?.amount).toBe('199.00');
    expect(await store.findOccurrence(user.userId, schedule.id, '2026-11-24')).toMatchObject({
      amount: '249.00',
    });
  });

  it('skips an occurrence with an audited retry receipt and keeps the month-end anchor', async () => {
    const { store, user, env } = await account();
    const date = new Date('2026-01-31T12:00:00Z');
    const schedule = await createRecurring(
      store,
      user.userId,
      input({ firstDate: '2026-01-31' }),
      date,
    );
    const skip = {
      recurringId: schedule.id,
      expectedVersion: 1,
      occurrenceDate: '2026-01-31',
      idempotencyKey: key(),
    };
    const skipped = await skipRecurring(store, user.userId, skip, date);
    expect(await skipRecurring(store, user.userId, skip, date)).toEqual(skipped);
    expect(skipped.nextDate).toBe('2026-02-28');
    expect((await recordDueOccurrences(store, [user.userId], date)).recorded).toBe(0);
    await recordDueOccurrences(store, [user.userId], new Date('2026-02-28T12:00:00Z'));
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      nextDate: '2026-03-31',
    });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
    expect(await store.findOccurrence(user.userId, schedule.id, '2026-01-31')).toBeUndefined();
  });

  it('never recreates a deleted automatic charge', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const entry = await recordAutomaticOccurrence(store, user.userId, schedule.id, now);
    await deleteExpense(
      store,
      user.userId,
      {
        expenseId: entry.id,
        expectedVersion: 1,
        match: { description: entry.description },
        idempotencyKey: key(),
      },
      now,
    );
    expect((await recordDueOccurrences(store, [user.userId], now)).recorded).toBe(0);
    await expect(
      confirmRecurring(
        store,
        user.userId,
        {
          recurringId: schedule.id,
          expectedVersion: 2,
          occurrenceDate: entry.date,
          paidDate: entry.date,
          amount: entry.amount,
          idempotencyKey: key(),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_DELETED' });
    expect(await getCashFlow(store, user.userId, {})).toEqual({ totals: [] });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(1);
  });

  it('catches up missed runs within a bounded budget without recording future dates', async () => {
    const { store, user } = await account();
    const schedule = await createRecurring(
      store,
      user.userId,
      input({ firstDate: '2026-01-31' }),
      now,
    );
    const through = new Date('2026-03-05T12:00:00Z');
    expect((await recordDueOccurrences(store, [user.userId], through, 1)).recorded).toBe(1);
    expect((await recordDueOccurrences(store, [user.userId], through, 1)).recorded).toBe(1);
    expect((await recordDueOccurrences(store, [user.userId], through, 1)).recorded).toBe(0);
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      nextDate: '2026-03-31',
    });
    await expect(recordDueOccurrences(store, [user.userId], through, 6)).rejects.toThrow();
  });

  it('rolls back the automatic entry, receipt, and schedule on an audit failure', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    await env.DB.exec(
      "CREATE TRIGGER fail_automatic BEFORE INSERT ON planning_mutations WHEN NEW.version = 2 BEGIN SELECT RAISE(ABORT, 'synthetic'); END",
    );
    try {
      expect((await recordDueOccurrences(store, [user.userId], now)).failed).toBe(1);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(0);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM expense_mutations').first('n')).toBe(0);
      expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
        version: 1,
        nextDate: '2026-10-24',
      });
    } finally {
      await env.DB.exec('DROP TRIGGER fail_automatic');
    }
  });

  it('continues processing another authorized owner after one owner fails', async () => {
    const { store, user, env } = await account();
    const other = await principal(env);
    const a = await createRecurring(store, user.userId, input(), now);
    const b = await createRecurring(store, other.userId, input(), now);
    await env.DB.exec(
      `CREATE TRIGGER fail_one_owner BEFORE INSERT ON expense_mutations WHEN NEW.owner_id = '${user.userId}' BEGIN SELECT RAISE(ABORT, 'synthetic'); END`,
    );
    try {
      const result = await recordDueOccurrences(store, [user.userId, other.userId], now);
      expect(result).toMatchObject({ recorded: 1, failed: 1 });
      expect(await store.findOccurrence(user.userId, a.id, a.nextDate)).toBeUndefined();
      expect(await store.findOccurrence(other.userId, b.id, b.nextDate)).toBeDefined();
    } finally {
      await env.DB.exec('DROP TRIGGER fail_one_owner');
    }
  });

  it('honors a pause that races with the ledger commit', async () => {
    const { store, user, env } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const racing = {
      ...store,
      commit: async (mutation: Parameters<typeof store.commit>[0]) => {
        await cancelRecurring(
          store,
          user.userId,
          { recurringId: schedule.id, expectedVersion: 1, idempotencyKey: key() },
          now,
        );
        await store.commit(mutation);
      },
    };
    await expect(
      recordAutomaticOccurrence(racing, user.userId, schedule.id, now),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM expenses').first('n')).toBe(0);
    expect(await store.findRecurring(user.userId, schedule.id)).toMatchObject({
      active: false,
      version: 2,
    });
  });

  it('runs the scheduled handler only for explicitly allowed owners and fails closed without an allowlist', async () => {
    const { env, user, store } = await account();
    const other = await principal(env);
    const a = await createRecurring(store, user.userId, input(), now);
    const b = await createRecurring(store, other.userId, input(), now);
    expect(await automaticRecordingOwners(env.DB, [user.subject])).toEqual([user.userId]);
    const ctx = createExecutionContext();
    worker.scheduled(
      createScheduledController({ scheduledTime: now }),
      bindings({ ALLOWED_GOOGLE_SUBJECTS: user.subject }),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await store.findOccurrence(user.userId, a.id, a.nextDate)).toBeDefined();
    expect(await store.findOccurrence(other.userId, b.id, b.nextDate)).toBeUndefined();
    expect(
      (
        await dispatch(
          new Request(`${env.APP_ORIGIN}/__scheduled`),
          bindings({ ALLOWED_GOOGLE_SUBJECTS: user.subject }),
        )
      ).status,
    ).toBe(404);
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const denied = createExecutionContext();
    worker.scheduled(
      createScheduledController({ scheduledTime: now }),
      bindings({ ALLOWED_GOOGLE_SUBJECTS: '' }),
      denied,
    );
    await expect(waitOnExecutionContext(denied)).rejects.toThrow(
      'Automatic recurring recording failed.',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('automatic_recording_failed'));
    expect(log.mock.calls.flat().join(' ')).not.toContain('Netflix');
    expect(log.mock.calls.flat().join(' ')).not.toContain(user.subject);
  });

  it('exposes automatic recording and user controls over MCP while enforcing write scope', async () => {
    const { env, user, store } = await account();
    const client = await connect(env, user.token);
    const reader = await principal(env, ['ledger:read']);
    const readClient = await connect(env, reader.token);
    try {
      const created = await client.callTool({
        name: 'create_recurring_entry',
        arguments: input({ firstDate: '2099-01-31' }),
      });
      const schedule = z
        .object({ recurring: recurringSchema })
        .parse(created.structuredContent).recurring;
      expect(schedule.automatic).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'skip_recurring_occurrence',
            arguments: {
              recurringId: schedule.id,
              expectedVersion: 1,
              occurrenceDate: schedule.nextDate,
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      ).toMatchObject({ recurring: { nextDate: '2099-02-28' } });
      expect(
        (
          await client.callTool({
            name: 'update_recurring_entry',
            arguments: {
              recurringId: schedule.id,
              expectedVersion: 2,
              changes: { active: false },
              idempotencyKey: key(),
            },
          })
        ).structuredContent,
      ).toMatchObject({ recurring: { active: false } });
      for (const tool of [
        {
          name: 'skip_recurring_occurrence',
          arguments: {
            recurringId: schedule.id,
            expectedVersion: 3,
            occurrenceDate: '2099-02-28',
            idempotencyKey: key(),
          },
        },
        {
          name: 'update_recurring_entry',
          arguments: {
            recurringId: schedule.id,
            expectedVersion: 3,
            changes: { active: true, nextDate: '2099-02-28' },
            idempotencyKey: key(),
          },
        },
      ])
        expect(await readClient.callTool(tool)).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'FORBIDDEN' } },
        });
      await expect(
        updateRecurring(store, reader.userId, {
          recurringId: schedule.id,
          expectedVersion: 3,
          changes: { active: false },
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await client.close();
      await readClient.close();
    }
  });

  it('returns automatic provenance in duplicate warnings so the agent can reconcile rather than duplicate', async () => {
    const { env, user, store } = await account();
    const schedule = await createRecurring(store, user.userId, input(), now);
    const automatic = await recordAutomaticOccurrence(store, user.userId, schedule.id, now);
    const client = await connect(env, user.token);
    try {
      const warning = await client.callTool({
        name: 'create_entry',
        arguments: expenseInput({
          type: 'expense',
          description: schedule.description,
          amount: '300',
          date: '2026-10-24',
          category: schedule.category,
        }),
      });
      expect(warning.structuredContent).toMatchObject({
        error: {
          code: 'POSSIBLE_DUPLICATE',
          candidates: [{ id: automatic.id, source: 'recurring', paymentStatus: 'unverified' }],
        },
      });
      const confirmed = await client.callTool({
        name: 'confirm_recurring_payment',
        arguments: {
          recurringId: schedule.id,
          expectedVersion: 2,
          occurrenceDate: '2026-10-24',
          paidDate: '2026-10-24',
          amount: '300',
          existingEntryId: automatic.id,
          expectedEntryVersion: 1,
          idempotencyKey: key(),
        },
      });
      expect(
        z.object({ entry: expenseSchema }).parse(confirmed.structuredContent).entry,
      ).toMatchObject({ id: automatic.id, paymentStatus: 'confirmed' });
    } finally {
      await client.close();
    }
  });
});
