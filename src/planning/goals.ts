import type { z } from 'zod';
import type { PlanningStore } from './store';
import { LedgerError, formatMinor, toMinor, todayInMexico } from '../domain/expense';
import { requestHash } from '../domain/mutation';
import {
  type Goal,
  contributeSchema,
  createGoalSchema,
  goalSchema,
  planningListSchema,
  updateGoalSchema,
} from '../domain/planning';
import { replayPlanMutation, commitPlanMutation } from './mutations';

export function goalProgress(goal: Goal) {
  const saved = BigInt(goal.savedMinor);
  const target = BigInt(toMinor(goal.targetAmount));
  return {
    ...goal,
    savedAmount: formatMinor(saved),
    remainingAmount: formatMinor(target > saved ? target - saved : 0n),
    reached: saved >= target,
  };
}

export async function createGoal(
  store: PlanningStore,
  ownerId: string,
  raw: z.input<typeof createGoalSchema>,
  now = new Date(),
) {
  const input = createGoalSchema.parse(raw);
  const hash = await requestHash('createGoal', input);
  const prior = await replayPlanMutation(store, ownerId, input.idempotencyKey, hash);
  if (prior) return goalProgress(goalSchema.parse(prior.after));
  const { idempotencyKey, ...fields } = input;
  const after: Goal = {
    ...fields,
    id: crypto.randomUUID(),
    savedMinor: '0',
    active: true,
    version: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return goalProgress(
    goalSchema.parse(
      await commitPlanMutation(store, {
        ownerId,
        key: idempotencyKey,
        hash,
        kind: 'goal',
        before: null,
        after,
        details: { operation: 'create' },
      }),
    ),
  );
}

export async function updateGoal(
  store: PlanningStore,
  ownerId: string,
  raw: z.infer<typeof updateGoalSchema>,
  now = new Date(),
) {
  const input = updateGoalSchema.parse(raw);
  const hash = await requestHash('updateGoal', input);
  const prior = await replayPlanMutation(store, ownerId, input.idempotencyKey, hash);
  if (prior) return goalProgress(goalSchema.parse(prior.after));
  const before = await store.findGoal(ownerId, input.goalId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Savings goal not found.');
  if (before.version !== input.expectedVersion)
    throw new LedgerError('CONFLICT', 'Goal changed. List again.');
  const after = {
    ...before,
    ...input.changes,
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  return goalProgress(
    goalSchema.parse(
      await commitPlanMutation(store, {
        ownerId,
        key: input.idempotencyKey,
        hash,
        kind: 'goal',
        before,
        after,
        details: { operation: 'update' },
      }),
    ),
  );
}

export async function contributeToGoal(
  store: PlanningStore,
  ownerId: string,
  raw: z.infer<typeof contributeSchema>,
  now = new Date(),
) {
  const input = contributeSchema.parse(raw);
  const hash = await requestHash('contributeToGoal', input);
  const prior = await replayPlanMutation(store, ownerId, input.idempotencyKey, hash);
  if (prior) return goalProgress(goalSchema.parse(prior.after));
  const before = await store.findGoal(ownerId, input.goalId);
  if (!before) throw new LedgerError('NOT_FOUND', 'Savings goal not found.');
  if (!before.active || before.version !== input.expectedVersion)
    throw new LedgerError('CONFLICT', 'Goal changed or archived. List again.');
  if (input.date > todayInMexico(now))
    throw new LedgerError(
      'INVALID_INPUT',
      'Future savings contributions are not confirmed savings.',
    );
  const minor = BigInt(toMinor(input.amount));
  const saved = BigInt(before.savedMinor) + (input.direction === 'deposit' ? minor : -minor);
  if (saved < 0n || saved > 999999999999n)
    throw new LedgerError(
      'INVALID_INPUT',
      'Contribution would exceed the supported balance or withdraw more than saved.',
    );
  const after = {
    ...before,
    savedMinor: saved.toString(),
    version: before.version + 1,
    updatedAt: now.toISOString(),
  };
  const { idempotencyKey: _key, ...details } = input;
  return goalProgress(
    goalSchema.parse(
      await commitPlanMutation(store, {
        ownerId,
        key: input.idempotencyKey,
        hash,
        kind: 'goal',
        before,
        after,
        details: { operation: 'contribution', ...details },
      }),
    ),
  );
}

export async function listGoals(
  store: PlanningStore,
  ownerId: string,
  raw: z.input<typeof planningListSchema>,
) {
  const input = planningListSchema.parse(raw);
  const rows = await store.listGoals(ownerId, input);
  const items = rows.slice(0, input.limit);
  return {
    goals: items.map(goalProgress),
    nextAfterId: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
  };
}
