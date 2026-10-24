import { eq, gte, isNull, isNotNull, lte, sql, type AnyColumn } from 'drizzle-orm';
import { toMinor, type Filter } from '../domain/expense';
import { expenses } from './schema';

export function normalizedDescription(column: AnyColumn) {
  let expression = sql`lower(${column})`;
  for (const [from, to] of [
    ['á', 'a'],
    ['é', 'e'],
    ['í', 'i'],
    ['ó', 'o'],
    ['ú', 'u'],
    ['ü', 'u'],
    ['ñ', 'n'],
    ['Á', 'a'],
    ['É', 'e'],
    ['Í', 'i'],
    ['Ó', 'o'],
    ['Ú', 'u'],
    ['Ü', 'u'],
    ['Ñ', 'n'],
  ]) {
    expression = sql`replace(${expression}, ${sql.raw(`'${from}'`)}, ${sql.raw(`'${to}'`)})`;
  }
  return expression;
}
export function filterConditions(
  ownerId: string,
  filter: Filter,
  deleted: 'exclude' | 'include' | 'only' = 'exclude',
) {
  return [
    eq(expenses.ownerId, ownerId),
    filter.type ? eq(expenses.type, filter.type) : undefined,
    filter.recurringId ? eq(expenses.recurringId, filter.recurringId) : undefined,
    filter.paymentStatus ? eq(expenses.paymentStatus, filter.paymentStatus) : undefined,
    deleted === 'exclude'
      ? isNull(expenses.deletedAt)
      : deleted === 'only'
        ? isNotNull(expenses.deletedAt)
        : undefined,
    filter.from ? gte(expenses.date, filter.from) : undefined,
    filter.to ? lte(expenses.date, filter.to) : undefined,
    filter.category ? eq(expenses.category, filter.category) : undefined,
    filter.currency ? eq(expenses.currency, filter.currency) : undefined,
    filter.minAmount ? gte(expenses.amountMinor, toMinor(filter.minAmount)) : undefined,
    filter.maxAmount ? lte(expenses.amountMinor, toMinor(filter.maxAmount)) : undefined,
    filter.query
      ? sql`instr(${normalizedDescription(expenses.description)}, ${filter.query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()}) > 0`
      : undefined,
  ];
}
