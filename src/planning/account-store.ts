import type { Budget, Preferences } from '../domain/insights';

export type AccountMutation = { ownerId: string; key: string; hash: string } & (
  | { kind: 'budget'; before: Budget | null; after: Budget }
  | { kind: 'preferences'; before: Preferences | null; after: Preferences }
);
export type BudgetKey = Pick<Budget, 'month' | 'category' | 'currency'>;
export type AccountStore = {
  findBudget(ownerId: string, key: BudgetKey): Promise<Budget | undefined>;
  findPreferences(ownerId: string): Promise<Preferences | undefined>;
  findAccountMutation(
    ownerId: string,
    key: string,
  ): Promise<{ hash: string; kind: 'budget' | 'preferences'; after: unknown } | undefined>;
  commitAccount(mutation: AccountMutation): Promise<void>;
  listBudgets(
    ownerId: string,
    month: string,
    includeInactive: boolean,
  ): Promise<{ budget: Budget; spentMinor: string; unverifiedMinor: string; count: number }[]>;
};
