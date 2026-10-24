import { z } from 'zod';
import {
  amountSchema,
  categorySchema,
  currencySchema,
  dateSchema,
  descriptionSchema,
  duplicateConfirmationSchema,
  entryTypeSchema,
  keySchema,
  LedgerError,
} from './expense';

export const intervalSchema = z.enum(['weekly', 'monthly', 'yearly']);
export const versionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const createRecurringSchema = z.strictObject({
  description: descriptionSchema,
  type: entryTypeSchema,
  amount: amountSchema.describe(
    'Amount automatically recorded on each billing date unless automatic is false. Ask only when amount is unclear.',
  ),
  currency: currencySchema,
  category: categorySchema,
  interval: intervalSchema,
  firstDate: dateSchema.describe(
    'First billing date to record, not an inferred historical subscription start date.',
  ),
  automatic: z
    .boolean()
    .default(true)
    .describe(
      'Automatic recording is the default for a user-established recurring entry. Do not ask a second automation question.',
    ),
  idempotencyKey: keySchema,
});
export const recurringSchema = createRecurringSchema.omit({ idempotencyKey: true }).extend({
  automatic: z.boolean().default(false),
  needsReview: z.boolean().default(false),
  id: z.uuid(),
  nextDate: dateSchema,
  active: z.boolean(),
  version: versionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Recurring = z.infer<typeof recurringSchema>;
export const cancelRecurringSchema = z.strictObject({
  recurringId: z.uuid(),
  expectedVersion: versionSchema,
  idempotencyKey: keySchema,
});
export const confirmRecurringSchema = cancelRecurringSchema
  .extend({
    occurrenceDate: dateSchema,
    paidDate: dateSchema,
    existingEntryId: z.uuid().optional(),
    expectedEntryVersion: versionSchema.optional(),
    amount: amountSchema,
    duplicateConfirmation: duplicateConfirmationSchema.optional(),
  })
  .refine(
    (value) => Boolean(value.existingEntryId) === Boolean(value.expectedEntryVersion),
    'Supply both existingEntryId and expectedEntryVersion to link a recorded payment.',
  );
export const skipRecurringSchema = cancelRecurringSchema.extend({ occurrenceDate: dateSchema });
export const updateRecurringSchema = cancelRecurringSchema.extend({
  changes: z
    .strictObject({
      description: descriptionSchema.optional(),
      amount: amountSchema.optional(),
      category: categorySchema.optional(),
      automatic: z.boolean().optional(),
      active: z.boolean().optional(),
      nextDate: dateSchema.optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one change.'),
});
export const createGoalSchema = z.strictObject({
  name: descriptionSchema,
  targetAmount: amountSchema,
  currency: currencySchema,
  deadline: dateSchema.nullable().default(null),
  idempotencyKey: keySchema,
});
export const goalSchema = createGoalSchema.omit({ idempotencyKey: true }).extend({
  id: z.uuid(),
  savedMinor: z.string().regex(/^\d+$/),
  active: z.boolean(),
  version: versionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Goal = z.infer<typeof goalSchema>;
export const updateGoalSchema = z.strictObject({
  goalId: z.uuid(),
  expectedVersion: versionSchema,
  idempotencyKey: keySchema,
  changes: z
    .strictObject({
      name: descriptionSchema.optional(),
      targetAmount: amountSchema.optional(),
      deadline: dateSchema.nullable().optional(),
      active: z.boolean().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Provide at least one change.'),
});
export const contributeSchema = z.strictObject({
  goalId: z.uuid(),
  expectedVersion: versionSchema,
  idempotencyKey: keySchema,
  direction: z.enum(['deposit', 'withdraw']),
  amount: amountSchema,
  date: dateSchema,
  note: descriptionSchema.optional(),
});
export const planningListSchema = z.strictObject({
  includeInactive: z.boolean().default(false),
  afterId: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export const listRecurringSchema = planningListSchema
  .extend({ dueThrough: dateSchema.optional(), afterDate: dateSchema.optional() })
  .refine((input) => !input.afterDate || Boolean(input.afterId), 'afterDate requires afterId.');

// Retain the original day/month, so January 31 -> February 28 -> March 31.
export function nextOccurrence(
  recurring: Pick<Recurring, 'firstDate' | 'nextDate' | 'interval'>,
): string {
  const current = new Date(`${recurring.nextDate}T00:00:00Z`);
  const anchor = new Date(`${recurring.firstDate}T00:00:00Z`);
  if (recurring.interval === 'weekly') current.setUTCDate(current.getUTCDate() + 7);
  else {
    current.setUTCDate(1);
    if (recurring.interval === 'monthly') current.setUTCMonth(current.getUTCMonth() + 1);
    else {
      current.setUTCFullYear(current.getUTCFullYear() + 1);
      current.setUTCMonth(anchor.getUTCMonth());
    }
    const last = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
    ).getUTCDate();
    current.setUTCDate(Math.min(anchor.getUTCDate(), last));
  }
  const result = current.toISOString().slice(0, 10);
  if (!dateSchema.safeParse(result).success)
    throw new LedgerError('INVALID_INPUT', 'Recurrence exceeds supported calendar dates.');
  return result;
}
