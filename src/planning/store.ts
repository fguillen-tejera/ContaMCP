import type { z } from 'zod';
import type { Goal, Recurring, listRecurringSchema, planningListSchema } from '../domain/planning';

export type PlanMutation = {
  ownerId: string;
  key: string;
  hash: string;
  details: Record<string, unknown>;
} & (
  | { kind: 'recurring'; before: Recurring | null; after: Recurring }
  | { kind: 'goal'; before: Goal | null; after: Goal }
);
export type PlanningStore = {
  findPlanMutation(
    ownerId: string,
    key: string,
  ): Promise<{ hash: string; after: unknown } | undefined>;
  listDueRecurring(ownerId: string, through: string, limit: number): Promise<Recurring[]>;
  findRecurring(ownerId: string, id: string): Promise<Recurring | undefined>;
  findGoal(ownerId: string, id: string): Promise<Goal | undefined>;
  commitPlan(mutation: PlanMutation): Promise<void>;
  listRecurring(ownerId: string, input: z.infer<typeof listRecurringSchema>): Promise<Recurring[]>;
  listGoals(ownerId: string, input: z.infer<typeof planningListSchema>): Promise<Goal[]>;
};
