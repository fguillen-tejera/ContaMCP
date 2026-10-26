import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { todayInMexico } from '../domain/expense';
import { recurringEntries, users } from './schema';

// Restricted deployments resolve scheduled owners through the private subject allowlist.
export async function automaticRecordingOwners(binding: D1Database, subjects: readonly string[]) {
  const allowed = [...new Set(subjects.filter((subject) => subject.length > 0))];
  if (allowed.length === 0 || allowed.length > 100)
    throw new Error('Automatic recording requires an explicit bounded owner allowlist.');
  const owners = await drizzle(binding)
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.authProvider, 'google'), inArray(users.googleSubject, allowed)))
    .orderBy(users.id);
  return owners.map((owner) => owner.id);
}

// Public signup authorizes background work only through user-established automatic schedules.
export async function publicAutomaticRecordingOwners(binding: D1Database, now: Date) {
  const due = await drizzle(binding)
    .select({ ownerId: recurringEntries.ownerId })
    .from(recurringEntries)
    .where(
      and(
        sql`json_extract(${recurringEntries.data}, '$.active') = 1`,
        sql`json_extract(${recurringEntries.data}, '$.automatic') = 1`,
        sql`COALESCE(json_extract(${recurringEntries.data}, '$.needsReview'), 0) = 0`,
        sql`json_extract(${recurringEntries.data}, '$.nextDate') <= ${todayInMexico(now)}`,
      ),
    )
    .orderBy(sql`json_extract(${recurringEntries.data}, '$.nextDate')`, recurringEntries.id)
    .limit(5);
  return [...new Set(due.map((row) => row.ownerId))];
}
