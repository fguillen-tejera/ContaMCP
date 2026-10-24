import { and, eq, gt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { recurringSchema } from '../domain/planning';
import { LedgerError } from '../domain/expense';
import type { PlanningStore, PlanMutation } from '../planning/store';
import { planningMutations, recurringEntries, savingsGoals } from './schema';

export function planningStore(binding: D1Database): PlanningStore {
  const db = drizzle(binding);
  return {
    async findPlanMutation(ownerId, key) {
      return db
        .select({ hash: planningMutations.hash, after: planningMutations.after })
        .from(planningMutations)
        .where(
          and(eq(planningMutations.ownerId, ownerId), eq(planningMutations.key, `user_${key}`)),
        )
        .get();
    },
    async findRecurring(ownerId, id) {
      const row = await db
        .select()
        .from(recurringEntries)
        .where(and(eq(recurringEntries.ownerId, ownerId), eq(recurringEntries.id, id)))
        .get();
      return row ? recurringSchema.parse(row.data) : undefined;
    },
    async listDueRecurring(ownerId, through, limit) {
      const rows = await db
        .select()
        .from(recurringEntries)
        .where(
          and(
            eq(recurringEntries.ownerId, ownerId),
            sql`json_extract(${recurringEntries.data}, '$.active') = 1`,
            sql`json_extract(${recurringEntries.data}, '$.automatic') = 1`,
            sql`COALESCE(json_extract(${recurringEntries.data}, '$.needsReview'), 0) = 0`,
            sql`json_extract(${recurringEntries.data}, '$.nextDate') <= ${through}`,
          ),
        )
        .orderBy(sql`json_extract(${recurringEntries.data}, '$.nextDate')`, recurringEntries.id)
        .limit(limit);
      return rows.map((row) => recurringSchema.parse(row.data));
    },
    async findGoal(ownerId, id) {
      return (
        await db
          .select()
          .from(savingsGoals)
          .where(and(eq(savingsGoals.ownerId, ownerId), eq(savingsGoals.id, id)))
          .get()
      )?.data;
    },
    async commitPlan(mutation: PlanMutation) {
      const { ownerId, before, after } = mutation;
      const table = mutation.kind === 'goal' ? savingsGoals : recurringEntries;
      const version = before
        ? sql<number>`CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${table.ownerId} = ${ownerId} AND ${table.id} = ${after.id} AND ${table.version} = ${before.version}) THEN ${after.version} ELSE NULL END`
        : after.version;
      const receipt = db.insert(planningMutations).values({
        ownerId,
        key: `user_${mutation.key}`,
        hash: mutation.hash,
        kind: mutation.kind,
        entityId: after.id,
        version,
        before,
        after,
        details: mutation.details,
        createdAt: after.updatedAt,
      });
      // Keep typed table writes explicit; both the receipt guard and write live in the same batch.
      if (mutation.kind === 'goal') {
        const values = { id: after.id, ownerId, version: after.version, data: mutation.after };
        await db.batch([
          receipt,
          mutation.before
            ? db
                .update(savingsGoals)
                .set(values)
                .where(
                  and(
                    eq(savingsGoals.ownerId, ownerId),
                    eq(savingsGoals.id, after.id),
                    eq(savingsGoals.version, mutation.before.version),
                  ),
                )
            : db.insert(savingsGoals).values(values),
        ]);
      } else {
        const values = { id: after.id, ownerId, version: after.version, data: mutation.after };
        await db.batch([
          receipt,
          mutation.before
            ? db
                .update(recurringEntries)
                .set(values)
                .where(
                  and(
                    eq(recurringEntries.ownerId, ownerId),
                    eq(recurringEntries.id, after.id),
                    eq(recurringEntries.version, mutation.before.version),
                  ),
                )
            : db.insert(recurringEntries).values(values),
        ]);
      }
    },
    async listRecurring(ownerId, input) {
      const nextDate = sql<string>`json_extract(${recurringEntries.data}, '$.nextDate')`;
      let afterDate = input.afterDate;
      if (input.afterId && !afterDate) {
        const anchor = await db
          .select({ data: recurringEntries.data })
          .from(recurringEntries)
          .where(and(eq(recurringEntries.ownerId, ownerId), eq(recurringEntries.id, input.afterId)))
          .get();
        if (!anchor)
          throw new LedgerError('INVALID_INPUT', 'Invalid recurring pagination position.');
        afterDate = anchor.data.nextDate;
      }
      const rows = await db
        .select()
        .from(recurringEntries)
        .where(
          and(
            eq(recurringEntries.ownerId, ownerId),
            input.afterId && afterDate
              ? or(
                  gt(nextDate, afterDate),
                  and(eq(nextDate, afterDate), gt(recurringEntries.id, input.afterId)),
                )
              : undefined,
            input.includeInactive
              ? undefined
              : sql`json_extract(${recurringEntries.data}, '$.active') = 1`,
            input.dueThrough
              ? sql`json_extract(${recurringEntries.data}, '$.nextDate') <= ${input.dueThrough}`
              : undefined,
          ),
        )
        .orderBy(nextDate, recurringEntries.id)
        .limit(input.limit + 1);
      return rows.map((row) => recurringSchema.parse(row.data));
    },
    async listGoals(ownerId, input) {
      const rows = await db
        .select()
        .from(savingsGoals)
        .where(
          and(
            eq(savingsGoals.ownerId, ownerId),
            input.afterId ? gt(savingsGoals.id, input.afterId) : undefined,
            input.includeInactive
              ? undefined
              : sql`json_extract(${savingsGoals.data}, '$.active') = 1`,
          ),
        )
        .orderBy(savingsGoals.id)
        .limit(input.limit + 1);
      return rows.map((row) => row.data);
    },
  };
}
