import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { formatMinor, toMinor } from '../domain/expense';
import { budgetSchema, monthEnd, preferencesSchema } from '../domain/insights';
import type { AccountStore } from '../planning/account-store';
import { accountMutations, expenses, monthlyBudgets, userPreferences } from './schema';

function asBudget(row: typeof monthlyBudgets.$inferSelect) {
  const { ownerId: _owner, amountMinor, ...rest } = row;
  return budgetSchema.parse({ ...rest, limitAmount: formatMinor(BigInt(amountMinor)) });
}
export function accountStore(binding: D1Database): AccountStore {
  const db = drizzle(binding);
  return {
    async findBudget(ownerId, key) {
      const row = await db
        .select()
        .from(monthlyBudgets)
        .where(
          and(
            eq(monthlyBudgets.ownerId, ownerId),
            eq(monthlyBudgets.month, key.month),
            eq(monthlyBudgets.category, key.category),
            eq(monthlyBudgets.currency, key.currency),
          ),
        )
        .get();
      return row ? asBudget(row) : undefined;
    },
    async findPreferences(ownerId) {
      const row = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.ownerId, ownerId))
        .get();
      if (!row) return;
      const { ownerId: _owner, ...rest } = row;
      return preferencesSchema.parse(rest);
    },
    async findAccountMutation(ownerId, key) {
      return db
        .select({
          hash: accountMutations.hash,
          kind: accountMutations.kind,
          after: accountMutations.after,
        })
        .from(accountMutations)
        .where(and(eq(accountMutations.ownerId, ownerId), eq(accountMutations.key, key)))
        .get();
    },
    async commitAccount(mutation) {
      const { ownerId, before, after } = mutation;
      const table = mutation.kind === 'budget' ? monthlyBudgets : userPreferences;
      const receipt = db.insert(accountMutations).values({
        ownerId,
        key: mutation.key,
        hash: mutation.hash,
        kind: mutation.kind,
        entityId: after.id,
        version: before
          ? sql`CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${table.ownerId} = ${ownerId} AND ${table.id} = ${after.id} AND ${table.version} = ${before.version}) THEN ${after.version} ELSE NULL END`
          : after.version,
        before,
        after,
        createdAt: after.updatedAt,
      });
      if (mutation.kind === 'budget') {
        const { limitAmount, ...budget } = mutation.after;
        const values = { ...budget, ownerId, amountMinor: toMinor(limitAmount) };
        await db.batch([
          receipt,
          before
            ? db
                .update(monthlyBudgets)
                .set(values)
                .where(
                  and(
                    eq(monthlyBudgets.ownerId, ownerId),
                    eq(monthlyBudgets.id, after.id),
                    eq(monthlyBudgets.version, before.version),
                  ),
                )
            : db.insert(monthlyBudgets).values(values),
        ]);
      } else {
        const values = { ...mutation.after, ownerId };
        await db.batch([
          receipt,
          before
            ? db
                .update(userPreferences)
                .set(values)
                .where(
                  and(
                    eq(userPreferences.ownerId, ownerId),
                    eq(userPreferences.id, after.id),
                    eq(userPreferences.version, before.version),
                  ),
                )
            : db.insert(userPreferences).values(values),
        ]);
      }
    },
    async listBudgets(ownerId, month, includeInactive) {
      const rows = await db
        .select({
          budget: monthlyBudgets,
          spentMinor: sql<string>`CAST(COALESCE(SUM(${expenses.amountMinor}), 0) AS TEXT)`,
          unverifiedMinor: sql<string>`CAST(COALESCE(SUM(CASE WHEN ${expenses.paymentStatus} = 'unverified' THEN ${expenses.amountMinor} ELSE 0 END), 0) AS TEXT)`,
          count: sql<number>`COUNT(${expenses.id})`,
        })
        .from(monthlyBudgets)
        .leftJoin(
          expenses,
          and(
            eq(expenses.ownerId, ownerId),
            eq(expenses.category, monthlyBudgets.category),
            eq(expenses.currency, monthlyBudgets.currency),
            eq(expenses.type, 'expense'),
            isNull(expenses.deletedAt),
            sql`${expenses.date} >= ${`${month}-01`} AND ${expenses.date} <= ${monthEnd(month)}`,
          ),
        )
        .where(
          and(
            eq(monthlyBudgets.ownerId, ownerId),
            eq(monthlyBudgets.month, month),
            includeInactive ? undefined : eq(monthlyBudgets.active, true),
          ),
        )
        .groupBy(monthlyBudgets.id)
        .orderBy(monthlyBudgets.category, monthlyBudgets.currency);
      return rows.map((row) => ({ ...row, budget: asBudget(row.budget) }));
    },
  };
}
