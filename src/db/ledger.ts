import { and, desc, eq, gte, isNull, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
  type CorrectionMatch,
  type Expense,
  expenseSchema,
  formatMinor,
  toMinor,
} from '../domain/expense';
import type { LedgerStore } from '../expenses/service';
import { expenses, mutations, recurringEntries, planningMutations } from './schema';
import { planningStore } from './planning';
import { accountStore } from './accounts';
import { queryStore } from './queries';
import { filterConditions, normalizedDescription } from './filters';
import {
  duplicateTokens,
  type DuplicateProbe,
  type DuplicateAcknowledgement,
} from '../expenses/duplicates';

function asExpense(row: typeof expenses.$inferSelect): Expense {
  const { ownerId: _ownerId, amountMinor, ...rest } = row;
  return { ...rest, amountMinor: amountMinor.toString(), amount: formatMinor(BigInt(amountMinor)) };
}

function correctionConditions(ownerId: string, match: CorrectionMatch, deleted = false) {
  return and(
    eq(expenses.ownerId, ownerId),
    match.type ? eq(expenses.type, match.type) : undefined,
    deleted ? isNotNull(expenses.deletedAt) : isNull(expenses.deletedAt),
    match.description === undefined ? undefined : eq(expenses.description, match.description),
    match.date === undefined ? undefined : eq(expenses.date, match.date),
    match.category === undefined ? undefined : eq(expenses.category, match.category),
    match.currency === undefined ? undefined : eq(expenses.currency, match.currency),
    match.currentAmount === undefined
      ? undefined
      : eq(expenses.amountMinor, toMinor(match.currentAmount)),
  );
}

function duplicateConditions(
  ownerId: string,
  probe: DuplicateProbe,
  acknowledged: DuplicateAcknowledgement[] = [],
  excludeId?: string,
) {
  const minor = BigInt(probe.amountMinor);
  const tolerance = minor / 20n > 0n ? minor / 20n : 1n;
  const tokens = duplicateTokens(probe.description);
  const normalized = normalizedDescription(expenses.description);
  const overlap = tokens.length
    ? sql.join(
        tokens.map((token) => sql`CASE WHEN instr(${normalized}, ${token}) > 0 THEN 1 ELSE 0 END`),
        sql` + `,
      )
    : sql`0`;
  return and(
    eq(expenses.ownerId, ownerId),
    isNull(expenses.deletedAt),
    eq(expenses.type, probe.type),
    eq(expenses.currency, probe.currency),
    sql`${expenses.date} BETWEEN date(${probe.date}, '-3 days') AND date(${probe.date}, '+3 days')`,
    or(
      and(
        gte(expenses.amountMinor, Number(minor - tolerance)),
        lte(expenses.amountMinor, Number(minor + tolerance)),
      ),
      and(eq(expenses.source, 'recurring'), eq(expenses.paymentStatus, 'unverified')),
    ),
    tokens.length
      ? sql`(${overlap}) >= ${Math.ceil(tokens.length / 2)}`
      : sql`lower(trim(${expenses.description})) = lower(trim(${probe.description}))`,
    excludeId ? sql`${expenses.id} != ${excludeId}` : undefined,
    ...acknowledged.map(
      (item) => sql`NOT (${expenses.id} = ${item.id} AND ${expenses.version} = ${item.version})`,
    ),
  );
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function receiptEntryHash(receipt: {
  expenseId: string;
  version: number;
  key: string;
  hash: string;
  before: Expense | null;
  after: Expense;
  createdAt: string;
  prevHash: string | null;
}): Promise<string> {
  return sha256Hex(
    canonicalize({
      expenseId: receipt.expenseId,
      version: receipt.version,
      key: receipt.key,
      requestHash: receipt.hash,
      before: receipt.before,
      after: receipt.after,
      createdAt: receipt.createdAt,
      prevHash: receipt.prevHash,
    }),
  );
}

export type AuditChainResult =
  | { valid: true; checked: number }
  | { valid: false; expenseId: string; version: number };

// Missing hashes, including legacy receipts, cannot establish integrity. Compare
// receipts and current entries from one snapshot so concurrent writes cannot look like truncation.
export async function verifyAuditChain(
  binding: D1Database,
  ownerId: string,
): Promise<AuditChainResult> {
  const db = drizzle(binding);
  const [rows, receipts] = await db.batch([
    db.select().from(expenses).where(eq(expenses.ownerId, ownerId)),
    db
      .select()
      .from(mutations)
      .where(eq(mutations.ownerId, ownerId))
      .orderBy(mutations.expenseId, mutations.version),
  ]);
  const current = new Map(rows.map((row) => [row.id, asExpense(row)]));
  const latest = new Map<string, Expense>();
  let previous: (typeof receipts)[number] | undefined;
  let checked = 0;
  for (const receipt of receipts) {
    const prior = latest.get(receipt.expenseId);
    const after = expenseSchema.safeParse(receipt.after);
    const before = receipt.before === null ? null : expenseSchema.safeParse(receipt.before);
    const linked = previous?.expenseId === receipt.expenseId ? previous.entryHash : null;
    if (
      !current.has(receipt.expenseId) ||
      receipt.entryHash === null ||
      receipt.version !== (prior?.version ?? 0) + 1 ||
      receipt.prevHash !== linked ||
      !after.success ||
      after.data.id !== receipt.expenseId ||
      after.data.version !== receipt.version ||
      after.data.updatedAt !== receipt.createdAt ||
      (prior
        ? !before?.success || canonicalize(before.data) !== canonicalize(prior)
        : before !== null)
    )
      return { valid: false, expenseId: receipt.expenseId, version: receipt.version };
    if ((await receiptEntryHash(receipt)) !== receipt.entryHash)
      return { valid: false, expenseId: receipt.expenseId, version: receipt.version };
    latest.set(receipt.expenseId, after.data);
    checked += 1;
    previous = receipt;
  }
  for (const [id, entry] of current) {
    if (canonicalize(latest.get(id)) !== canonicalize(entry))
      return { valid: false, expenseId: id, version: entry.version };
  }
  return { valid: true, checked };
}

export function ledgerStore(binding: D1Database): LedgerStore {
  const db = drizzle(binding);
  return {
    ...planningStore(binding),
    ...accountStore(binding),
    ...queryStore(binding),
    async findDuplicates(ownerId, probe) {
      const rows = await db
        .select()
        .from(expenses)
        .where(duplicateConditions(ownerId, probe))
        .orderBy(expenses.date, expenses.id)
        .limit(21);
      return rows.map(asExpense);
    },
    async findMutation(ownerId, key) {
      const receipt = await db
        .select({ hash: mutations.hash, after: mutations.after })
        .from(mutations)
        .where(and(eq(mutations.ownerId, ownerId), eq(mutations.key, key)))
        .get();
      return receipt
        ? { hash: receipt.hash, after: expenseSchema.parse(receipt.after) }
        : undefined;
    },
    async findOccurrence(ownerId, recurringId, occurrenceDate) {
      const row = await db
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.ownerId, ownerId),
            eq(expenses.recurringId, recurringId),
            eq(expenses.occurrenceDate, occurrenceDate),
          ),
        )
        .get();
      return row ? asExpense(row) : undefined;
    },
    async findExpense(ownerId, id) {
      const row = await db
        .select()
        .from(expenses)
        .where(and(eq(expenses.ownerId, ownerId), eq(expenses.id, id)))
        .get();
      return row ? asExpense(row) : undefined;
    },
    async findCorrectionMatches(ownerId, match, deleted) {
      const rows = await db
        .select()
        .from(expenses)
        .where(correctionConditions(ownerId, match, deleted))
        .limit(2);
      return rows.map(asExpense);
    },
    async commit(mutation) {
      const { after, before, ownerId } = mutation;
      // The previous receipt of this expense is already committed and immutable,
      // so reading it outside the batch is race-free; the (expense, version) unique
      // index still serializes concurrent writers of the same version.
      const prevReceipt = before
        ? await db
            .select({ entryHash: mutations.entryHash })
            .from(mutations)
            .where(
              and(
                eq(mutations.ownerId, ownerId),
                eq(mutations.expenseId, after.id),
                eq(mutations.version, before.version),
              ),
            )
            .get()
        : undefined;
      const prevHash = prevReceipt?.entryHash ?? null;
      const entryHash = await receiptEntryHash({
        expenseId: after.id,
        version: after.version,
        key: mutation.key,
        hash: mutation.hash,
        before,
        after,
        createdAt: after.updatedAt,
        prevHash,
      });
      const values = {
        id: after.id,
        ownerId,
        source: after.source,
        paymentStatus: after.paymentStatus,
        type: after.type,
        recurringId: after.recurringId,
        occurrenceDate: after.occurrenceDate,
        description: after.description,
        amountMinor: toMinor(after.amount),
        currency: after.currency,
        date: after.date,
        category: after.category,
        version: after.version,
        deletedAt: after.deletedAt,
        createdAt: after.createdAt,
        updatedAt: after.updatedAt,
      };
      const schedule = mutation.schedule;
      const scheduleGuard = schedule
        ? sql`EXISTS(SELECT 1 FROM ${recurringEntries} WHERE ${recurringEntries.ownerId} = ${ownerId} AND ${recurringEntries.id} = ${schedule.before.id} AND ${recurringEntries.version} = ${schedule.before.version} AND json_extract(${recurringEntries.data}, '$.active') = 1 AND json_extract(${recurringEntries.data}, '$.nextDate') = ${schedule.before.nextDate} AND ${after.paymentStatus === 'unverified' ? sql`json_extract(${recurringEntries.data}, '$.automatic') = 1` : sql`1`})`
        : sql`1`;
      const scheduleWrites = schedule
        ? [
            db.insert(planningMutations).values({
              ownerId,
              key: `occurrence_${after.id}_${after.version}`,
              hash: mutation.hash,
              kind: 'recurring',
              entityId: schedule.after.id,
              version: schedule.after.version,
              before: schedule.before,
              after: schedule.after,
              details: {
                operation: after.paymentStatus === 'unverified' ? 'automatic_recording' : 'confirm',
                entryId: after.id,
                occurrenceDate: after.occurrenceDate,
                paidDate: after.date,
              },
              createdAt: after.updatedAt,
            }),
            db
              .update(recurringEntries)
              .set({ data: schedule.after, version: schedule.after.version })
              .where(
                and(
                  eq(recurringEntries.ownerId, ownerId),
                  eq(recurringEntries.id, schedule.before.id),
                  eq(recurringEntries.version, schedule.before.version),
                ),
              ),
          ]
        : [];
      const receipt = db.insert(mutations).values({
        ownerId,
        key: mutation.key,
        hash: mutation.hash,
        expenseId: after.id,
        // A failed correction precondition must abort the whole batch, including its receipt.
        // Checking in the receipt statement also closes the candidate-query/commit race.
        version: mutation.before
          ? sql`CASE WHEN
              (SELECT COUNT(*) FROM (SELECT 1 FROM ${expenses} WHERE ${correctionConditions(ownerId, mutation.match, mutation.restore)} LIMIT 2)) = 1
              AND EXISTS (SELECT 1 FROM ${expenses} WHERE ${and(
                correctionConditions(ownerId, mutation.match, mutation.restore),
                eq(expenses.id, after.id),
                eq(expenses.version, mutation.before.version),
              )})
              AND ${scheduleGuard}
              AND ${mutation.restore ? sql`NOT EXISTS(SELECT 1 FROM ${expenses} WHERE ${duplicateConditions(ownerId, after, mutation.duplicateConfirmation, after.id)})` : sql`1`}
              THEN ${after.version} ELSE NULL END`
          : sql`CASE WHEN NOT EXISTS(SELECT 1 FROM ${expenses} WHERE ${duplicateConditions(ownerId, after, mutation.duplicateConfirmation, after.id)})
            AND ${scheduleGuard}
            THEN ${after.version} ELSE NULL END`,
        before,
        after,
        prevHash,
        entryHash,
        createdAt: after.updatedAt,
      });
      if (before) {
        // The unique (expense, version) audit entry serializes concurrent corrections.
        // D1 batch rolls back both statements if a retry key or version already exists.
        await db.batch([
          receipt,
          db
            .update(expenses)
            .set(values)
            .where(
              and(
                eq(expenses.ownerId, ownerId),
                eq(expenses.id, after.id),
                eq(expenses.version, before.version),
              ),
            ),
          ...scheduleWrites,
        ]);
      } else {
        await db.batch([db.insert(expenses).values(values), receipt, ...scheduleWrites]);
      }
    },
    async list(ownerId, filter, cursor) {
      const rows = await db
        .select()
        .from(expenses)
        .where(
          and(
            ...filterConditions(ownerId, filter, filter.deleted),
            cursor
              ? or(
                  lt(expenses.date, cursor.date),
                  and(eq(expenses.date, cursor.date), lt(expenses.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(expenses.date), desc(expenses.id))
        .limit(filter.limit + 1);
      return rows.map(asExpense);
    },
    async exportPage(ownerId, type, limit, cursor) {
      const rows = await db
        .select()
        .from(expenses)
        .where(
          and(
            eq(expenses.ownerId, ownerId),
            type ? eq(expenses.type, type) : undefined,
            cursor
              ? sql`(${expenses.createdAt}, ${expenses.id}) > (${cursor.createdAt}, ${cursor.id})`
              : undefined,
          ),
        )
        .orderBy(expenses.createdAt, expenses.id)
        .limit(limit + 1);
      return rows.map(asExpense);
    },
    async totals(ownerId, filter) {
      // SQLite SUM stays an integer; casting to text avoids JS Number precision loss.
      return db
        .select({
          type: expenses.type,
          currency: expenses.currency,
          minor: sql<string>`CAST(SUM(${expenses.amountMinor}) AS TEXT)`,
          count: sql<number>`COUNT(*)`,
          unverifiedCount: sql<number>`SUM(CASE WHEN ${expenses.paymentStatus} = 'unverified' THEN 1 ELSE 0 END)`,
        })
        .from(expenses)
        .where(and(...filterConditions(ownerId, filter)))
        .groupBy(expenses.currency, expenses.type)
        .orderBy(expenses.currency);
    },
  };
}
