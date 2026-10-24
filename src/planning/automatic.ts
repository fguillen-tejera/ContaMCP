import { LedgerError, createExpenseSchema, todayInMexico } from '../domain/expense';
import { requestHash } from '../domain/mutation';
import { nextOccurrence, type Recurring } from '../domain/planning';
import { createExpense } from '../expenses/service';
import type { LedgerStore } from '../expenses/store';
import { commitPlanMutation } from './mutations';

export async function recordAutomaticOccurrence(
  store: LedgerStore,
  ownerId: string,
  recurringId: string,
  now = new Date(),
) {
  const before = await store.findRecurring(ownerId, recurringId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Recurring entry not found.');
  if (
    !before.active ||
    !before.automatic ||
    before.needsReview ||
    before.nextDate > todayInMexico(now)
  )
    throw new LedgerError('CONFLICT', 'Recurring entry is not eligible for automatic recording.');
  const hash = await requestHash('automaticOccurrence', {
    recurringId,
    occurrenceDate: before.nextDate,
  });
  const after: Recurring = {
    ...before,
    nextDate: nextOccurrence(before),
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  return createExpense(
    store,
    ownerId,
    createExpenseSchema.parse({
      description: before.description,
      type: before.type,
      amount: before.amount,
      currency: before.currency,
      category: before.category,
      date: before.nextDate,
      idempotencyKey: `auto_${before.id}_${before.nextDate}`,
    }),
    now,
    { schedule: { before, after }, hash, automatic: true },
  );
}

async function requireReview(store: LedgerStore, ownerId: string, before: Recurring, now: Date) {
  const after: Recurring = {
    ...before,
    needsReview: true,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  const hash = await requestHash('automaticReview', {
    recurringId: before.id,
    expectedVersion: before.version,
    occurrenceDate: before.nextDate,
  });
  await commitPlanMutation(store, {
    ownerId,
    kind: 'recurring',
    key: `auto_review_${before.id}_${before.version}`,
    hash,
    before,
    after,
    details: {
      operation: 'automatic_review',
      reason: 'POSSIBLE_DUPLICATE',
      occurrenceDate: before.nextDate,
    },
  });
}

export type AutomaticRecordingResult = {
  recorded: number;
  needsReview: number;
  deferred: number;
  failed: number;
};

// Only the composition layer supplies owners authorized for this internal scheduled job.
export async function recordDueOccurrences(
  store: LedgerStore,
  ownerIds: readonly string[],
  now = new Date(),
  budget = 5,
): Promise<AutomaticRecordingResult> {
  if (!Number.isInteger(budget) || budget < 1 || budget > 5)
    throw new Error('Invalid automatic recording budget.');
  const result: AutomaticRecordingResult = { recorded: 0, needsReview: 0, deferred: 0, failed: 0 };
  const unavailable = new Set<string>();
  const owners = [...new Set(ownerIds)];
  const through = todayInMexico(now);
  let attempts = 0;
  while (attempts < budget) {
    let found = false;
    for (const ownerId of owners) {
      if (attempts >= budget) break;
      if (unavailable.has(ownerId)) continue;
      try {
        const recurring = (await store.listDueRecurring(ownerId, through, 1))[0];
        if (!recurring) {
          unavailable.add(ownerId);
          continue;
        }
        found = true;
        attempts++;
        try {
          await recordAutomaticOccurrence(store, ownerId, recurring.id, now);
          result.recorded++;
        } catch (error) {
          if (error instanceof LedgerError && error.code === 'POSSIBLE_DUPLICATE') {
            await requireReview(store, ownerId, recurring, now);
            result.needsReview++;
          } else if (error instanceof LedgerError && error.code === 'CONFLICT') {
            result.deferred++;
            unavailable.add(ownerId);
          } else throw error;
        }
      } catch (error) {
        if (error instanceof LedgerError && error.code === 'CONFLICT') result.deferred++;
        else result.failed++;
        unavailable.add(ownerId);
      }
    }
    if (!found) break;
  }
  return result;
}
