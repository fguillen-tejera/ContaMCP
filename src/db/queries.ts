import { and, eq, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { LedgerStore } from '../expenses/store';
import {
  accountMutations,
  expenses,
  monthlyBudgets,
  mutations,
  planningMutations,
  recurringEntries,
  savingsGoals,
  userPreferences,
} from './schema';
import { filterConditions } from './filters';
import { formatMinor } from '../domain/expense';

export function queryStore(
  binding: D1Database,
): Pick<LedgerStore, 'report' | 'history' | 'exportDataset'> {
  const db = drizzle(binding);
  return {
    async report(ownerId, input, previousFrom) {
      const period = sql<
        'current' | 'previous'
      >`CASE WHEN ${expenses.date} >= ${input.from} THEN 'current' ELSE 'previous' END`;
      const bucket =
        input.groupBy === 'month' ? sql<string>`substr(${expenses.date}, 1, 7)` : expenses.category;
      return db
        .select({
          period,
          bucket,
          type: expenses.type,
          currency: expenses.currency,
          minor: sql<string>`CAST(SUM(${expenses.amountMinor}) AS TEXT)`,
          count: sql<number>`COUNT(*)`,
          unverifiedCount: sql<number>`SUM(CASE WHEN ${expenses.paymentStatus} = 'unverified' THEN 1 ELSE 0 END)`,
        })
        .from(expenses)
        .where(and(...filterConditions(ownerId, { ...input, from: previousFrom ?? input.from })))
        .groupBy(period, bucket, expenses.type, expenses.currency)
        .orderBy(period, bucket, expenses.currency, expenses.type);
    },
    async history(ownerId, input) {
      if (input.kind === 'entry') {
        const rows = await db
          .select({
            version: mutations.version,
            recordedAt: mutations.createdAt,
            before: mutations.before,
            after: mutations.after,
          })
          .from(mutations)
          .where(
            and(
              eq(mutations.ownerId, ownerId),
              eq(mutations.expenseId, input.entityId),
              gt(mutations.version, input.afterVersion),
            ),
          )
          .orderBy(mutations.version)
          .limit(input.limit + 1);
        return rows.map((row) => ({
          ...row,
          before: row.before ?? null,
          details: {
            operation: row.after.deletedAt
              ? 'delete'
              : row.before?.deletedAt
                ? 'restore'
                : row.before
                  ? 'update'
                  : 'create',
          },
        }));
      }
      if (input.kind === 'budget') {
        const rows = await db
          .select({
            version: accountMutations.version,
            recordedAt: accountMutations.createdAt,
            before: accountMutations.before,
            after: accountMutations.after,
          })
          .from(accountMutations)
          .where(
            and(
              eq(accountMutations.ownerId, ownerId),
              eq(accountMutations.kind, 'budget'),
              eq(accountMutations.entityId, input.entityId),
              gt(accountMutations.version, input.afterVersion),
            ),
          )
          .orderBy(accountMutations.version)
          .limit(input.limit + 1);
        return rows.map((row) => ({
          ...row,
          before: row.before ?? null,
          details: { operation: 'set_budget' },
        }));
      }
      return db
        .select({
          version: planningMutations.version,
          recordedAt: planningMutations.createdAt,
          before: planningMutations.before,
          after: planningMutations.after,
          details: planningMutations.details,
        })
        .from(planningMutations)
        .where(
          and(
            eq(planningMutations.ownerId, ownerId),
            eq(planningMutations.kind, input.kind),
            eq(planningMutations.entityId, input.entityId),
            gt(planningMutations.version, input.afterVersion),
          ),
        )
        .orderBy(planningMutations.version)
        .limit(input.limit + 1);
    },
    async exportDataset(ownerId, dataset, limit, after) {
      if (dataset === 'recurring' || dataset === 'goals') {
        const table = dataset === 'recurring' ? recurringEntries : savingsGoals;
        const rows = await db
          .select({ key: table.id, data: table.data })
          .from(table)
          .where(and(eq(table.ownerId, ownerId), after ? gt(table.id, after) : undefined))
          .orderBy(table.id)
          .limit(limit + 1);
        return rows.map((row) => ({ key: row.key, record: row.data }));
      }
      if (dataset === 'budgets') {
        const rows = await db
          .select()
          .from(monthlyBudgets)
          .where(
            and(
              eq(monthlyBudgets.ownerId, ownerId),
              after ? gt(monthlyBudgets.id, after) : undefined,
            ),
          )
          .orderBy(monthlyBudgets.id)
          .limit(limit + 1);
        return rows.map(({ ownerId: _owner, amountMinor, ...row }) => ({
          key: row.id,
          record: { ...row, limitAmount: formatMinor(BigInt(amountMinor)) },
        }));
      }
      if (dataset === 'preferences') {
        const rows = await db
          .select()
          .from(userPreferences)
          .where(
            and(
              eq(userPreferences.ownerId, ownerId),
              after ? gt(userPreferences.id, after) : undefined,
            ),
          )
          .orderBy(userPreferences.id)
          .limit(limit + 1);
        return rows.map(({ ownerId: _owner, ...row }) => ({ key: row.id, record: row }));
      }
      if (dataset === 'entry_history') {
        const rows = await db
          .select()
          .from(mutations)
          .where(and(eq(mutations.ownerId, ownerId), after ? gt(mutations.key, after) : undefined))
          .orderBy(mutations.key)
          .limit(limit + 1);
        return rows.map(({ ownerId: _owner, ...row }) => ({ key: row.key, record: row }));
      }
      if (dataset === 'planning_history') {
        const rows = await db
          .select()
          .from(planningMutations)
          .where(
            and(
              eq(planningMutations.ownerId, ownerId),
              after ? gt(planningMutations.key, after) : undefined,
            ),
          )
          .orderBy(planningMutations.key)
          .limit(limit + 1);
        return rows.map(({ ownerId: _owner, ...row }) => ({ key: row.key, record: row }));
      }
      const rows = await db
        .select()
        .from(accountMutations)
        .where(
          and(
            eq(accountMutations.ownerId, ownerId),
            after ? gt(accountMutations.key, after) : undefined,
          ),
        )
        .orderBy(accountMutations.key)
        .limit(limit + 1);
      return rows.map(({ ownerId: _owner, ...row }) => ({ key: row.key, record: row }));
    },
  };
}
