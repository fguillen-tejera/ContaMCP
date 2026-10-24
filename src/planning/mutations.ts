import type { PlanningStore, PlanMutation } from './store';
import { LedgerError } from '../domain/expense';
import { goalSchema, recurringSchema } from '../domain/planning';

export async function replayPlanMutation(
  store: PlanningStore,
  ownerId: string,
  key: string,
  hash: string,
) {
  const prior = await store.findPlanMutation(ownerId, key);
  if (prior && prior.hash !== hash)
    throw new LedgerError(
      'IDEMPOTENCY_CONFLICT',
      'Key already used for a different planning mutation.',
    );
  return prior;
}

export async function commitPlanMutation(store: PlanningStore, mutation: PlanMutation) {
  try {
    await store.commitPlan(mutation);
    return mutation.after;
  } catch (error) {
    const prior = await replayPlanMutation(store, mutation.ownerId, mutation.key, mutation.hash);
    if (prior)
      return mutation.kind === 'goal'
        ? goalSchema.parse(prior.after)
        : recurringSchema.parse(prior.after);
    if (mutation.before) {
      const current =
        mutation.kind === 'goal'
          ? await store.findGoal(mutation.ownerId, mutation.after.id)
          : await store.findRecurring(mutation.ownerId, mutation.after.id);
      if (current?.version !== mutation.before.version)
        throw new LedgerError(
          'CONFLICT',
          'Record changed. List again before retrying a new intent.',
        );
    }
    throw error;
  }
}
