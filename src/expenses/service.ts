import { requestHash } from '../domain/mutation';
import type { Recurring } from '../domain/planning';
import type { LedgerStore, Mutation } from './store';
import { requireDuplicateConfirmation } from './duplicates';
import {
  type CreateExpense,
  type CorrectionMatch,
  type Cursor,
  type DeleteExpense,
  type Expense,
  type Filter,
  type ListExpenses,
  type UpdateExpense,
  LedgerError,
  createExpenseSchema,
  cursorSchema,
  deleteExpenseSchema,
  formatMinor,
  listExpenseSchema,
  filterSchema,
  todayInMexico,
  toMinor,
  updateExpenseSchema,
  restoreEntrySchema,
} from '../domain/expense';
import type { z } from 'zod';

export type { LedgerStore, Mutation } from './store';

async function replay(
  store: LedgerStore,
  ownerId: string,
  key: string,
  hash: string,
  expectedType?: Expense['type'],
) {
  const prior = await store.findMutation(ownerId, key);
  // Cached receipts must respect the same entry-type boundary as a fresh lookup.
  if (prior && expectedType && prior.after.type !== expectedType)
    throw new LedgerError('NOT_FOUND', 'Entry not found.');
  if (prior && prior.hash !== hash) {
    throw new LedgerError(
      'IDEMPOTENCY_CONFLICT',
      'This key was already used for a different mutation.',
    );
  }
  return prior?.after;
}

export async function commitLedgerMutation(
  store: LedgerStore,
  mutation: Mutation,
): Promise<Expense> {
  try {
    await store.commit(mutation);
    return mutation.after;
  } catch (error) {
    // A simultaneous retry may have committed while this request was preparing its write.
    const prior = await replay(
      store,
      mutation.ownerId,
      mutation.key,
      mutation.hash,
      mutation.after.type,
    );
    if (prior) return prior;
    if (mutation.before) {
      const current = await store.findExpense(mutation.ownerId, mutation.before.id);
      if (current?.version !== mutation.before.version) {
        throw new LedgerError('CONFLICT', 'Expense changed. List it again before correcting it.');
      }
      if (mutation.match)
        await checkCorrectionMatch(
          store,
          mutation.ownerId,
          current,
          mutation.match,
          mutation.restore,
        );
      if (mutation.restore)
        requireDuplicateConfirmation(
          await store.findDuplicates(mutation.ownerId, mutation.after),
          mutation.duplicateConfirmation,
        );
    } else {
      requireDuplicateConfirmation(
        await store.findDuplicates(mutation.ownerId, mutation.after),
        mutation.duplicateConfirmation,
      );
    }
    if (mutation.schedule) {
      const current = await store.findRecurring(mutation.ownerId, mutation.schedule.before.id);
      if (
        !current?.active ||
        current.version !== mutation.schedule.before.version ||
        current.nextDate !== mutation.schedule.before.nextDate
      )
        throw new LedgerError(
          'CONFLICT',
          'Recurring entry changed or occurrence already recorded. List again.',
        );
    }
    throw error;
  }
}

async function checkCorrectionMatch(
  store: LedgerStore,
  ownerId: string,
  expense: Expense | undefined,
  match: CorrectionMatch,
  deleted = false,
) {
  const candidates = await store.findCorrectionMatches(ownerId, match, deleted);
  if (candidates.length > 1)
    throw new LedgerError(
      'AMBIGUOUS_TARGET',
      'Multiple expenses match that reference. Ask the user which expense and obtain distinguishing facts before correcting anything. Do not choose by ID, recency or list position.',
    );
  if (candidates.length !== 1 || candidates[0]?.id !== expense?.id)
    throw new LedgerError(
      'CONFLICT',
      'The identifying facts no longer select this expense. List again and clarify the target.',
    );
}

export async function createExpense(
  store: LedgerStore,
  ownerId: string,
  raw: CreateExpense,
  now = new Date(),
  context?: {
    schedule: { before: Recurring; after: Recurring };
    hash: string;
    automatic?: boolean;
  },
) {
  const input = createExpenseSchema.parse(raw);
  const { type, ...legacyInput } = input;
  const hash =
    context?.hash ?? (await requestHash('create', type === 'expense' ? legacyInput : input));
  const prior = await replay(store, ownerId, input.idempotencyKey, hash, input.type);
  if (prior) return prior;
  const minor = toMinor(input.amount).toString();
  const after: Expense = {
    source: context?.automatic ? 'recurring' : 'user',
    paymentStatus: context?.automatic ? 'unverified' : 'confirmed',
    type: input.type,
    recurringId: context?.schedule.before.id ?? null,
    occurrenceDate: context?.schedule.before.nextDate ?? null,
    id: crypto.randomUUID(),
    description: input.description,
    amount: formatMinor(minor),
    amountMinor: minor,
    currency: input.currency,
    date: input.date ?? todayInMexico(now),
    category: input.category,
    version: 1,
    deletedAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  requireDuplicateConfirmation(
    await store.findDuplicates(ownerId, after),
    input.duplicateConfirmation,
  );
  return commitLedgerMutation(store, {
    ownerId,
    key: input.idempotencyKey,
    hash,
    before: null,
    after,
    duplicateConfirmation: input.duplicateConfirmation,
    schedule: context?.schedule,
  });
}

export async function updateExpense(
  store: LedgerStore,
  ownerId: string,
  raw: UpdateExpense,
  now = new Date(),
) {
  const input = updateExpenseSchema.parse(raw);
  const { type: matchType, ...legacyMatch } = input.match;
  const hash = await requestHash(
    'update',
    matchType === 'expense' ? { ...input, match: legacyMatch } : input,
  );
  const prior = await replay(store, ownerId, input.idempotencyKey, hash, input.match.type);
  if (prior) return prior;
  const before = await store.findExpense(ownerId, input.expenseId);
  if (!before || (input.match.type && input.match.type !== before.type))
    throw new LedgerError('NOT_FOUND', 'Entry not found.');
  if (before.deletedAt) {
    throw new LedgerError('ALREADY_DELETED', 'Expense is already deleted.');
  }
  if (before.version !== input.expectedVersion) {
    throw new LedgerError('CONFLICT', 'Expense changed. List it again before correcting it.');
  }
  await checkCorrectionMatch(store, ownerId, before, { ...input.match, type: before.type });
  const minor =
    input.changes.amount === undefined
      ? before.amountMinor
      : toMinor(input.changes.amount).toString();
  const after: Expense = {
    ...before,
    ...input.changes,
    amount: formatMinor(minor),
    amountMinor: minor,
    updatedAt: now.toISOString(),
    version: before.version + 1,
  };
  return commitLedgerMutation(store, {
    ownerId,
    key: input.idempotencyKey,
    hash,
    before,
    after,
    match: { ...input.match, type: before.type },
  });
}

export async function deleteExpense(
  store: LedgerStore,
  ownerId: string,
  raw: DeleteExpense,
  now = new Date(),
) {
  const input = deleteExpenseSchema.parse(raw);
  const { type: matchType, ...legacyMatch } = input.match;
  const hash = await requestHash(
    'delete',
    matchType === 'expense' ? { ...input, match: legacyMatch } : input,
  );
  const prior = await replay(store, ownerId, input.idempotencyKey, hash, input.match.type);
  if (prior) return prior;
  const before = await store.findExpense(ownerId, input.expenseId);
  if (!before || (input.match.type && input.match.type !== before.type))
    throw new LedgerError('NOT_FOUND', 'Entry not found.');
  if (before.deletedAt) {
    throw new LedgerError('ALREADY_DELETED', 'Expense is already deleted.');
  }
  if (before.version !== input.expectedVersion) {
    throw new LedgerError('CONFLICT', 'Expense changed. List it again before deleting it.');
  }
  await checkCorrectionMatch(store, ownerId, before, { ...input.match, type: before.type });
  const after: Expense = {
    ...before,
    deletedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: before.version + 1,
  };
  return commitLedgerMutation(store, {
    ownerId,
    key: input.idempotencyKey,
    hash,
    before,
    after,
    match: { ...input.match, type: before.type },
  });
}

export async function listExpenses(store: LedgerStore, ownerId: string, raw: ListExpenses) {
  const input = listExpenseSchema.parse(raw);
  let cursor: Cursor | undefined;
  if (input.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(atob(input.cursor)));
    } catch {
      throw new LedgerError('INVALID_INPUT', 'Invalid pagination cursor.');
    }
  }
  const rows = await store.list(ownerId, input, cursor);
  const expenses = rows.slice(0, input.limit);
  const last = expenses.at(-1);
  return {
    expenses,
    nextCursor:
      rows.length > input.limit && last
        ? btoa(JSON.stringify({ date: last.date, id: last.id }))
        : null,
  };
}

export async function restoreEntry(
  store: LedgerStore,
  ownerId: string,
  raw: z.input<typeof restoreEntrySchema>,
  now = new Date(),
) {
  const input = restoreEntrySchema.parse(raw);
  const hash = await requestHash('restore', input);
  const prior = await replay(store, ownerId, input.idempotencyKey, hash, input.match.type);
  if (prior) return prior;
  const before = await store.findExpense(ownerId, input.entryId);
  if (!before || (input.match.type && input.match.type !== before.type))
    throw new LedgerError('NOT_FOUND', 'Entry not found.');
  if (!before.deletedAt || before.version !== input.expectedVersion)
    throw new LedgerError(
      'CONFLICT',
      'Entry changed or is already live. List deleted entries again.',
    );
  const match = { ...input.match, type: before.type };
  await checkCorrectionMatch(store, ownerId, before, match, true);
  const after = {
    ...before,
    deletedAt: null,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  requireDuplicateConfirmation(
    await store.findDuplicates(ownerId, after),
    input.duplicateConfirmation,
  );
  return commitLedgerMutation(store, {
    ownerId,
    key: input.idempotencyKey,
    hash,
    before,
    after,
    match,
    restore: true,
    duplicateConfirmation: input.duplicateConfirmation,
  });
}

export async function getExpenseSummary(store: LedgerStore, ownerId: string, raw: Filter) {
  const filter = filterSchema.parse(raw);
  const totals = await store.totals(ownerId, { ...filter, type: 'expense' });
  return {
    totals: totals.map(({ currency, minor, count, unverifiedCount }) => ({
      currency,
      amountMinor: minor,
      amount: formatMinor(minor),
      count,
      unverifiedCount,
    })),
  };
}

export async function getCashFlow(store: LedgerStore, ownerId: string, raw: Filter) {
  const input = filterSchema.parse(raw);
  // One grouped query gives income and expenses from the same database snapshot.
  const totals = await store.totals(ownerId, input);
  const income = totals.filter((row) => row.type === 'income');
  const expenses = totals.filter((row) => row.type === 'expense');
  const currencies = [...new Set(totals.map((row) => row.currency))].sort();
  return {
    totals: currencies.map((currency) => {
      const received = BigInt(income.find((row) => row.currency === currency)?.minor ?? '0');
      const spent = BigInt(expenses.find((row) => row.currency === currency)?.minor ?? '0');
      return {
        currency,
        income: formatMinor(received),
        expenses: formatMinor(spent),
        net: formatMinor(received - spent),
        unverifiedCount: totals
          .filter((row) => row.currency === currency)
          .reduce((sum, row) => sum + row.unverifiedCount, 0),
      };
    }),
  };
}
