import { z } from 'zod';
import { LedgerError, formatMinor, type Expense } from '../domain/expense';
import {
  backupSchema,
  exportCursorSchema,
  exportSchema,
  historySchema,
  reportSchema,
  shiftDate,
  periodDays,
  type ReportRow,
} from '../domain/insights';
import type { LedgerStore } from './store';

function totals(rows: ReportRow[]) {
  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  return currencies.map((currency) => {
    const matching = rows.filter((row) => row.currency === currency);
    const sum = (type: 'income' | 'expense') =>
      matching
        .filter((row) => row.type === type)
        .reduce((total, row) => total + BigInt(row.minor), 0n);
    const income = sum('income');
    const expenses = sum('expense');
    return {
      currency,
      income: formatMinor(income),
      expenses: formatMinor(expenses),
      net: formatMinor(income - expenses),
      unverifiedCount: matching.reduce((count, row) => count + row.unverifiedCount, 0),
    };
  });
}
export async function getLedgerReport(
  store: LedgerStore,
  ownerId: string,
  raw: z.input<typeof reportSchema>,
) {
  const input = reportSchema.parse(raw);
  let previousFrom: string | undefined;
  try {
    if (input.comparePrevious)
      previousFrom = shiftDate(input.from, -periodDays(input.from, input.to));
  } catch {
    throw new LedgerError(
      'INVALID_INPUT',
      'Previous period would be earlier than the supported calendar.',
    );
  }
  const rows = await store.report(ownerId, input, previousFrom);
  const period = (name: 'current' | 'previous', from: string, to: string) => {
    const matching = rows.filter((row) => row.period === name);
    return {
      from,
      to,
      totals: totals(matching),
      groups: matching.map(({ period: _period, minor, ...row }) => ({
        ...row,
        amountMinor: minor,
        amount: formatMinor(minor),
      })),
    };
  };
  const current = period('current', input.from, input.to);
  const previous = previousFrom
    ? period('previous', previousFrom, shiftDate(input.from, -1))
    : null;
  const changes = previous
    ? [...new Set([...current.totals, ...previous.totals].map((row) => row.currency))]
        .sort()
        .map((currency) => {
          const a = current.totals.find((row) => row.currency === currency);
          const b = previous.totals.find((row) => row.currency === currency);
          const minor = (value: string | undefined) => BigInt((value ?? '0.00').replace('.', ''));
          return {
            currency,
            incomeDifference: formatMinor(minor(a?.income) - minor(b?.income)),
            expenseDifference: formatMinor(minor(a?.expenses) - minor(b?.expenses)),
            netDifference: formatMinor(minor(a?.net) - minor(b?.net)),
          };
        })
    : [];
  return { groupBy: input.groupBy, timezone: 'America/Mexico_City', current, previous, changes };
}
export async function getActivityHistory(
  store: LedgerStore,
  ownerId: string,
  raw: z.input<typeof historySchema>,
) {
  const input = historySchema.parse(raw);
  const rows = await store.history(ownerId, input);
  const activity = rows.slice(0, input.limit);
  return {
    activity,
    nextAfterVersion: rows.length > input.limit ? (activity.at(-1)?.version ?? null) : null,
  };
}
function decode(cursor: string): unknown {
  try {
    return JSON.parse(atob(cursor));
  } catch {
    throw new LedgerError('INVALID_INPUT', 'Invalid export cursor.');
  }
}
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export async function exportEntryPage(
  store: LedgerStore,
  ownerId: string,
  raw: z.input<typeof exportSchema>,
  type?: Expense['type'],
  now = new Date(),
) {
  const input = exportSchema.parse(raw);
  let cursor: z.infer<typeof exportCursorSchema> | undefined;
  if (input.cursor) {
    const parsed = exportCursorSchema.safeParse(decode(input.cursor));
    if (!parsed.success || parsed.data.type !== type)
      throw new LedgerError('INVALID_INPUT', 'Export cursor does not match this export.');
    cursor = parsed.data;
  }
  const rows = await store.exportPage(ownerId, type, input.limit, cursor);
  const entries = rows.slice(0, input.limit);
  const last = entries.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id, type }))
      : null;
  const result = {
    exportedAt: now.toISOString(),
    count: entries.length,
    nextCursor,
    format: input.format,
    consistency: 'live' as const,
  };
  if (input.format === 'json') return { ...result, entries, csv: undefined };
  const fields = [
    'id',
    'type',
    'date',
    'description',
    'amount',
    'currency',
    'category',
    'source',
    'paymentStatus',
    'recurringId',
    'occurrenceDate',
    'version',
    'deletedAt',
    'createdAt',
    'updatedAt',
  ] as const;
  return {
    ...result,
    entries: undefined,
    csv: [
      fields.map(csvCell).join(','),
      ...entries.map((entry) => fields.map((field) => csvCell(entry[field])).join(',')),
    ].join('\r\n'),
  };
}
const backupCursor = z.strictObject({
  dataset: backupSchema.shape.dataset,
  key: z.string().min(1).max(200),
});
export async function exportBackup(
  store: LedgerStore,
  ownerId: string,
  raw: z.input<typeof backupSchema>,
  now = new Date(),
) {
  const input = backupSchema.parse(raw);
  if (input.dataset === 'entries') {
    const page = await exportEntryPage(
      store,
      ownerId,
      { limit: input.limit, cursor: input.cursor },
      undefined,
      now,
    );
    return {
      exportedAt: page.exportedAt,
      dataset: input.dataset,
      consistency: page.consistency,
      count: page.count,
      nextCursor: page.nextCursor,
      records: page.entries ?? [],
    };
  }
  let after: string | undefined;
  if (input.cursor) {
    const parsed = backupCursor.safeParse(decode(input.cursor));
    if (!parsed.success || parsed.data.dataset !== input.dataset)
      throw new LedgerError('INVALID_INPUT', 'Cursor belongs to another backup dataset.');
    after = parsed.data.key;
  }
  const rows = await store.exportDataset(ownerId, input.dataset, input.limit, after);
  const page = rows.slice(0, input.limit);
  return {
    exportedAt: now.toISOString(),
    dataset: input.dataset,
    consistency: 'live' as const,
    count: page.length,
    records: page.map((item) => item.record),
    nextCursor:
      rows.length > input.limit
        ? btoa(JSON.stringify({ dataset: input.dataset, key: page.at(-1)?.key }))
        : null,
  };
}
