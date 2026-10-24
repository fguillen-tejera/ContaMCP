import { z } from 'zod';
import {
  amountSchema,
  categorySchema,
  currencySchema,
  dateSchema,
  filterSchema,
  keySchema,
} from './expense';

export const monthSchema = z.string().regex(/^(19\d{2}|[2-9]\d{3})-(0[1-9]|1[0-2])$/);
const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const budgetSchema = z.strictObject({
  id: z.uuid(),
  month: monthSchema,
  category: categorySchema,
  currency: currencySchema,
  limitAmount: amountSchema,
  active: z.boolean(),
  version: version.min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Budget = z.infer<typeof budgetSchema>;
export const setBudgetSchema = z.strictObject({
  month: monthSchema,
  category: categorySchema,
  currency: currencySchema,
  limitAmount: amountSchema,
  active: z.boolean().default(true),
  expectedVersion: version.default(0),
  idempotencyKey: keySchema,
});
export const listBudgetsSchema = z.strictObject({
  month: monthSchema,
  includeInactive: z.boolean().default(false),
});
export const preferencesSchema = z.strictObject({
  id: z.uuid(),
  defaultCurrency: currencySchema.nullable(),
  version: version.min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export function monthEnd(month: string) {
  const date = new Date(`${monthSchema.parse(month)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return date.toISOString().slice(0, 10);
}
export const setPreferencesSchema = z.strictObject({
  defaultCurrency: currencySchema
    .nullable()
    .describe('Only persist a default explicitly requested by the user; null clears it.'),
  expectedVersion: version.default(0),
  idempotencyKey: keySchema,
});

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  const result = value.toISOString().slice(0, 10);
  return dateSchema.parse(result);
}
export function periodDays(from: string, to: string) {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
}
export const reportSchema = filterSchema
  .safeExtend({
    from: dateSchema,
    to: dateSchema,
    groupBy: z.enum(['category', 'month']).default('category'),
    comparePrevious: z.boolean().default(false),
  })
  .refine((input) => periodDays(input.from, input.to) <= 366, 'Reports cover at most 366 days.');
export type Report = z.infer<typeof reportSchema>;
export type ReportRow = {
  period: 'current' | 'previous';
  bucket: string;
  type: 'income' | 'expense';
  currency: z.infer<typeof currencySchema>;
  minor: string;
  count: number;
  unverifiedCount: number;
};
export const historySchema = z.strictObject({
  kind: z.enum(['entry', 'recurring', 'goal', 'budget']),
  entityId: z.uuid(),
  afterVersion: version.default(0),
  limit: z.number().int().min(1).max(100).default(25),
});
export type HistoryInput = z.infer<typeof historySchema>;
export type Activity = {
  version: number;
  recordedAt: string;
  before: unknown;
  after: unknown;
  details: Record<string, unknown>;
};
export const exportSchema = z.strictObject({
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().max(600).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export const exportCursorSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  type: z.enum(['expense', 'income']).optional(),
});
export const backupDatasetSchema = z.enum([
  'entries',
  'recurring',
  'goals',
  'budgets',
  'preferences',
  'entry_history',
  'planning_history',
  'account_history',
]);
export const backupSchema = z.strictObject({
  dataset: backupDatasetSchema.default('entries'),
  limit: z.number().int().min(1).max(100).default(100),
  cursor: z.string().max(600).optional(),
});
export type BackupDataset = z.infer<typeof backupDatasetSchema>;
