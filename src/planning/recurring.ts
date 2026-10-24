import type { z } from 'zod';
import type { PlanningStore } from './store';
import {
  LedgerError,
  createExpenseSchema,
  formatMinor,
  toMinor,
  todayInMexico,
  type Expense,
} from '../domain/expense';
import { requestHash } from '../domain/mutation';
import {
  type Recurring,
  cancelRecurringSchema,
  skipRecurringSchema,
  updateRecurringSchema,
  confirmRecurringSchema,
  createRecurringSchema,
  listRecurringSchema,
  nextOccurrence,
  recurringSchema,
} from '../domain/planning';
import type { LedgerStore } from '../expenses/store';
import { createExpense, commitLedgerMutation } from '../expenses/service';
import { replayPlanMutation, commitPlanMutation } from './mutations';

export async function createRecurring(
  store: PlanningStore,
  ownerId: string,
  raw: z.input<typeof createRecurringSchema>,
  now = new Date(),
) {
  const input = createRecurringSchema.parse(raw);
  const hash = await requestHash('createRecurring', input);
  const prior = await store.findPlanMutation(ownerId, input.idempotencyKey);
  if (prior) {
    const { automatic: _automatic, ...legacy } = input;
    const compatible =
      raw.automatic === undefined && prior.hash === (await requestHash('createRecurring', legacy));
    if (prior.hash !== hash && !compatible)
      throw new LedgerError(
        'IDEMPOTENCY_CONFLICT',
        'Key already used for a different planning mutation.',
      );
    return recurringSchema.parse(prior.after);
  }
  const { idempotencyKey, ...fields } = input;
  const after: Recurring = {
    ...fields,
    id: crypto.randomUUID(),
    nextDate: input.firstDate,
    active: true,
    needsReview: false,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return recurringSchema.parse(
    await commitPlanMutation(store, {
      ownerId,
      key: idempotencyKey,
      hash,
      kind: 'recurring',
      before: null,
      after,
      details: { operation: 'create' },
    }),
  );
}

export async function cancelRecurring(
  store: PlanningStore,
  ownerId: string,
  raw: z.infer<typeof cancelRecurringSchema>,
  now = new Date(),
) {
  const input = cancelRecurringSchema.parse(raw);
  const hash = await requestHash('cancelRecurring', input);
  const prior = await replayPlanMutation(store, ownerId, input.idempotencyKey, hash);
  if (prior) return recurringSchema.parse(prior.after);
  const before = await store.findRecurring(ownerId, input.recurringId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Recurring entry not found.');
  if (before.version !== input.expectedVersion)
    throw new LedgerError('CONFLICT', 'Recurring entry changed. List again.');
  const after = {
    ...before,
    active: false,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  return recurringSchema.parse(
    await commitPlanMutation(store, {
      ownerId,
      key: input.idempotencyKey,
      hash,
      kind: 'recurring',
      before,
      after,
      details: { operation: 'cancel' },
    }),
  );
}

export async function confirmRecurring(
  store: LedgerStore,
  ownerId: string,
  raw: z.infer<typeof confirmRecurringSchema>,
  now = new Date(),
): Promise<Expense> {
  const input = confirmRecurringSchema.parse(raw);
  const hash = await requestHash('confirmRecurring', input);
  const prior = await store.findMutation(ownerId, input.idempotencyKey);
  if (prior) {
    if (prior.hash !== hash)
      throw new LedgerError(
        'IDEMPOTENCY_CONFLICT',
        'Key already used for a different ledger mutation.',
      );
    return prior.after;
  }
  const before = await store.findRecurring(ownerId, input.recurringId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Recurring entry not found.');
  if (before.version !== input.expectedVersion)
    throw new LedgerError('CONFLICT', 'Recurring entry changed. List it again.');
  if (input.paidDate > todayInMexico(now))
    throw new LedgerError('INVALID_INPUT', 'A future payment cannot be confirmed as paid.');
  const recorded = await store.findOccurrence(ownerId, before.id, input.occurrenceDate);
  if (recorded) {
    if (recorded.deletedAt)
      throw new LedgerError(
        'ALREADY_DELETED',
        'This occurrence was deleted. Do not create it again.',
      );
    if (recorded.paymentStatus === 'confirmed')
      throw new LedgerError(
        'CONFLICT',
        'Occurrence already confirmed. Correct the existing entry instead.',
      );
    if (input.existingEntryId && input.existingEntryId !== recorded.id)
      throw new LedgerError(
        'CONFLICT',
        'This occurrence already has an automatically recorded entry. Reconcile that entry instead of linking another.',
      );
    if (input.expectedEntryVersion === undefined)
      throw new LedgerError(
        'INVALID_INPUT',
        'List the automatically recorded entry and supply existingEntryId and expectedEntryVersion.',
      );
    if (recorded.version !== input.expectedEntryVersion)
      throw new LedgerError('CONFLICT', 'Automatically recorded entry changed. List it again.');
    return commitLedgerMutation(store, {
      ownerId,
      key: input.idempotencyKey,
      hash,
      before: recorded,
      after: {
        ...recorded,
        amount: formatMinor(BigInt(toMinor(input.amount))),
        amountMinor: toMinor(input.amount).toString(),
        date: input.paidDate,
        paymentStatus: 'confirmed',
        version: recorded.version + 1,
        updatedAt: now.toISOString(),
      },
      match: {
        type: recorded.type,
        description: recorded.description,
        date: recorded.date,
        currentAmount: recorded.amount,
        currency: recorded.currency,
      },
    });
  }
  if (!before.active || before.nextDate !== input.occurrenceDate)
    throw new LedgerError(
      'CONFLICT',
      'Recurring entry changed, paused, or occurrence already handled. List again.',
    );
  const after = {
    ...before,
    nextDate: nextOccurrence(before),
    needsReview: false,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  if (input.existingEntryId) {
    const entry = await store.findExpense(ownerId, input.existingEntryId);
    if (!entry) throw new LedgerError('NOT_FOUND', 'Entry not found.');
    if (
      entry.deletedAt ||
      entry.recurringId ||
      entry.version !== input.expectedEntryVersion ||
      entry.type !== before.type ||
      entry.currency !== before.currency ||
      entry.date !== input.paidDate ||
      BigInt(entry.amountMinor) !== BigInt(toMinor(input.amount))
    )
      throw new LedgerError(
        'CONFLICT',
        'Selected payment changed, is already linked, or does not match the confirmed amount, currency, type, and date.',
      );
    return commitLedgerMutation(store, {
      ownerId,
      key: input.idempotencyKey,
      hash,
      before: entry,
      after: {
        ...entry,
        recurringId: before.id,
        occurrenceDate: before.nextDate,
        version: entry.version + 1,
        updatedAt: now.toISOString(),
      },
      match: {
        type: entry.type,
        description: entry.description,
        date: entry.date,
        currentAmount: entry.amount,
        currency: entry.currency,
      },
      schedule: { before, after },
    });
  }
  return createExpense(
    store,
    ownerId,
    createExpenseSchema.parse({
      description: before.description,
      type: before.type,
      currency: before.currency,
      category: before.category,
      amount: input.amount,
      date: input.paidDate,
      idempotencyKey: input.idempotencyKey,
      duplicateConfirmation: input.duplicateConfirmation,
    }),
    now,
    { schedule: { before, after }, hash },
  );
}

export async function updateRecurring(
  store: PlanningStore,
  ownerId: string,
  raw: z.infer<typeof updateRecurringSchema>,
  now = new Date(),
) {
  const input = updateRecurringSchema.parse(raw);
  const hash = await requestHash('updateRecurring', input);
  const prior = await replayPlanMutation(store, ownerId, input.idempotencyKey, hash);
  if (prior) return recurringSchema.parse(prior.after);
  const before = await store.findRecurring(ownerId, input.recurringId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Recurring entry not found.');
  if (before.version !== input.expectedVersion)
    throw new LedgerError('CONFLICT', 'Recurring entry changed. List again.');
  const resuming = input.changes.active === true && !before.active;
  const enabling = input.changes.automatic === true && !before.automatic;
  if (
    (resuming || enabling) &&
    (!input.changes.nextDate || input.changes.nextDate < todayInMexico(now))
  )
    throw new LedgerError(
      'INVALID_INPUT',
      'Resuming or enabling automatic recording requires an explicit nextDate today or later.',
    );
  const after: Recurring = {
    ...before,
    ...input.changes,
    firstDate:
      input.changes.nextDate && input.changes.nextDate !== before.nextDate
        ? input.changes.nextDate
        : before.firstDate,
    needsReview: false,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  return recurringSchema.parse(
    await commitPlanMutation(store, {
      ownerId,
      key: input.idempotencyKey,
      hash,
      kind: 'recurring',
      before,
      after,
      details: { operation: 'update' },
    }),
  );
}

export async function skipRecurring(
  store: PlanningStore,
  ownerId: string,
  raw: z.infer<typeof skipRecurringSchema>,
  now = new Date(),
) {
  const input = skipRecurringSchema.parse(raw);
  const hash = await requestHash('skipRecurring', input);
  const prior = await replayPlanMutation(store, ownerId, input.idempotencyKey, hash);
  if (prior) return recurringSchema.parse(prior.after);
  const before = await store.findRecurring(ownerId, input.recurringId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Recurring entry not found.');
  if (
    !before.active ||
    before.version !== input.expectedVersion ||
    before.nextDate !== input.occurrenceDate
  )
    throw new LedgerError(
      'CONFLICT',
      'Recurring entry changed or occurrence already handled. List again.',
    );
  const after = {
    ...before,
    nextDate: nextOccurrence(before),
    needsReview: false,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  return recurringSchema.parse(
    await commitPlanMutation(store, {
      ownerId,
      key: input.idempotencyKey,
      hash,
      kind: 'recurring',
      before,
      after,
      details: { operation: 'skip', occurrenceDate: input.occurrenceDate },
    }),
  );
}

export async function listRecurring(
  store: PlanningStore,
  ownerId: string,
  raw: z.input<typeof listRecurringSchema>,
  now = new Date(),
) {
  const input = listRecurringSchema.parse(raw);
  const rows = await store.listRecurring(ownerId, input);
  const items = rows.slice(0, input.limit);
  const today = todayInMexico(now);
  return {
    recurring: items.map((item) => ({ ...item, due: item.active && item.nextDate <= today })),
    nextAfterId: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
    nextAfterDate: rows.length > input.limit ? (items.at(-1)?.nextDate ?? null) : null,
  };
}
