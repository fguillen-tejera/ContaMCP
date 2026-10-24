import type { z } from 'zod';
import { LedgerError, formatMinor, toMinor } from '../domain/expense';
import {
  budgetSchema,
  preferencesSchema,
  setBudgetSchema,
  setPreferencesSchema,
  listBudgetsSchema,
} from '../domain/insights';
import { requestHash } from '../domain/mutation';
import type { AccountMutation, AccountStore } from './account-store';

async function replay(store: AccountStore, ownerId: string, key: string, hash: string) {
  const prior = await store.findAccountMutation(ownerId, key);
  if (prior && prior.hash !== hash)
    throw new LedgerError(
      'IDEMPOTENCY_CONFLICT',
      'Key already used for another budget or preference change.',
    );
  return prior;
}
async function commit(store: AccountStore, mutation: AccountMutation) {
  try {
    await store.commitAccount(mutation);
    return mutation.after;
  } catch (error) {
    const prior = await replay(store, mutation.ownerId, mutation.key, mutation.hash);
    if (prior)
      return mutation.kind === 'budget'
        ? budgetSchema.parse(prior.after)
        : preferencesSchema.parse(prior.after);
    const current =
      mutation.kind === 'budget'
        ? await store.findBudget(mutation.ownerId, mutation.after)
        : await store.findPreferences(mutation.ownerId);
    if ((current?.version ?? 0) !== (mutation.before?.version ?? 0))
      throw new LedgerError(
        'CONFLICT',
        'Settings changed. Read them again before making a new change.',
      );
    throw error;
  }
}
export async function setMonthlyBudget(
  store: AccountStore,
  ownerId: string,
  raw: z.input<typeof setBudgetSchema>,
  now = new Date(),
) {
  const input = setBudgetSchema.parse(raw);
  const hash = await requestHash('setMonthlyBudget', input);
  const prior = await replay(store, ownerId, input.idempotencyKey, hash);
  if (prior) return budgetSchema.parse(prior.after);
  const before = await store.findBudget(ownerId, input);
  if ((before?.version ?? 0) !== input.expectedVersion)
    throw new LedgerError(
      'CONFLICT',
      'Budget changed. List this month first; use version 0 only for a new budget.',
    );
  const after = budgetSchema.parse({
    id: before?.id ?? crypto.randomUUID(),
    month: input.month,
    category: input.category,
    currency: input.currency,
    limitAmount: formatMinor(BigInt(toMinor(input.limitAmount))),
    active: input.active,
    version: input.expectedVersion + 1,
    createdAt: before?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return budgetSchema.parse(
    await commit(store, {
      kind: 'budget',
      ownerId,
      key: input.idempotencyKey,
      hash,
      before: before ?? null,
      after,
    }),
  );
}
export async function listMonthlyBudgets(
  store: AccountStore,
  ownerId: string,
  raw: z.input<typeof listBudgetsSchema>,
) {
  const input = listBudgetsSchema.parse(raw);
  const rows = await store.listBudgets(ownerId, input.month, input.includeInactive);
  return {
    month: input.month,
    timezone: 'America/Mexico_City',
    budgets: rows.map(({ budget, spentMinor, unverifiedMinor, count }) => {
      const spent = BigInt(spentMinor);
      const remaining = BigInt(toMinor(budget.limitAmount)) - spent;
      return {
        ...budget,
        spentAmount: formatMinor(spent),
        confirmedSpentAmount: formatMinor(spent - BigInt(unverifiedMinor)),
        unverifiedAmount: formatMinor(unverifiedMinor),
        remainingAmount: formatMinor(remaining),
        overBudget: remaining < 0n,
        count,
      };
    }),
  };
}
export async function getPreferences(store: AccountStore, ownerId: string) {
  const preferences = await store.findPreferences(ownerId);
  return {
    defaultCurrency: preferences?.defaultCurrency ?? null,
    version: preferences?.version ?? 0,
    timezone: 'America/Mexico_City',
  };
}
export async function setPreferences(
  store: AccountStore,
  ownerId: string,
  raw: z.input<typeof setPreferencesSchema>,
  now = new Date(),
) {
  const input = setPreferencesSchema.parse(raw);
  const hash = await requestHash('setPreferences', input);
  const prior = await replay(store, ownerId, input.idempotencyKey, hash);
  if (prior) return preferencesSchema.parse(prior.after);
  const before = await store.findPreferences(ownerId);
  if ((before?.version ?? 0) !== input.expectedVersion)
    throw new LedgerError('CONFLICT', 'Preferences changed. Read them again.');
  const after = preferencesSchema.parse({
    id: before?.id ?? crypto.randomUUID(),
    defaultCurrency: input.defaultCurrency,
    version: input.expectedVersion + 1,
    createdAt: before?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return preferencesSchema.parse(
    await commit(store, {
      kind: 'preferences',
      ownerId,
      key: input.idempotencyKey,
      hash,
      before: before ?? null,
      after,
    }),
  );
}
