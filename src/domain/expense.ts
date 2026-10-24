import { z } from 'zod';

export const categorySchema = z.enum([
  'food_drink',
  'groceries',
  'transport',
  'shopping',
  'entertainment',
  'education',
  'bills_services',
  'health',
  'home',
  'pets',
  'travel',
  'other',
]);
export const entryTypeSchema = z.enum(['income', 'expense']);
export const recordingSourceSchema = z.enum(['user', 'recurring']);
export const paymentStatusSchema = z.enum(['confirmed', 'unverified']);
export const currencySchema = z.enum(['MXN', 'USD', 'EUR']);
export const dateSchema = z.iso
  .date()
  .refine(
    (value) => value >= '1900-01-01' && value <= '9999-12-31',
    'Use a real calendar date between 1900-01-01 and 9999-12-31.',
  );
export const amountSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/,
    'Use a positive decimal string, e.g. "450.00"; no symbols, commas, or rounding.',
  )
  .refine((value) => /[1-9]/.test(value), 'Amount must be positive.');
export const descriptionSchema = z.string().trim().min(1).max(500);
export const keySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const duplicateConfirmationSchema = z
  .array(z.strictObject({ id: z.uuid(), version: z.number().int().positive() }))
  .max(20);
export const createExpenseSchema = z.strictObject({
  type: entryTypeSchema.default('expense'),
  duplicateConfirmation: duplicateConfirmationSchema
    .optional()
    .describe(
      'Only after the user confirms this is a separate entry: acknowledge every returned duplicate ID/version. Never auto-confirm.',
    ),
  description: descriptionSchema,
  amount: amountSchema.describe('Decimal major units as a string; never a JSON number.'),
  currency: currencySchema,
  date: dateSchema.optional().describe('YYYY-MM-DD; omitted means today in America/Mexico_City.'),
  category: categorySchema.describe(
    'Required. Infer confidently; ask the user when torn between two; other only when nothing fits.',
  ),
  idempotencyKey: keySchema.describe(
    'Unique per intended mutation; reuse unchanged when retrying.',
  ),
});
export const correctionMatchSchema = z
  .strictObject({
    type: entryTypeSchema.optional(),
    description: descriptionSchema.optional(),
    date: dateSchema.optional(),
    category: categorySchema.optional(),
    currency: currencySchema.optional(),
    currentAmount: amountSchema.optional(),
  })
  .refine(
    (value) =>
      value.description !== undefined ||
      value.date !== undefined ||
      value.category !== undefined ||
      value.currentAmount !== undefined,
    'Supply identifying facts from the user; currency alone is not a correction reference.',
  );
export type CorrectionMatch = z.infer<typeof correctionMatchSchema>;

export const updateExpenseSchema = z.strictObject({
  expenseId: z.uuid(),
  match: correctionMatchSchema.describe(
    'Existing-record facts explicitly supplied or confirmed by the user. Exact matching, combined with AND. Do not add facts merely copied from one candidate to make an ambiguous reference unique. Multiple matches are rejected even when expenseId is supplied.',
  ),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: keySchema,
  changes: z
    .strictObject({
      description: descriptionSchema.optional(),
      amount: amountSchema.optional(),
      currency: currencySchema.optional(),
      date: dateSchema.optional(),
      category: categorySchema.optional(),
    })
    .refine((changes) => Object.keys(changes).length > 0, 'Provide at least one change.'),
});
export const deleteExpenseSchema = z.strictObject({
  expenseId: z.uuid(),
  match: correctionMatchSchema.describe(
    'Existing-record facts explicitly supplied or confirmed by the user. Exact matching, combined with AND. Do not add facts merely copied from one candidate to make an ambiguous reference unique. Multiple matches are rejected even when expenseId is supplied.',
  ),
  expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  idempotencyKey: keySchema,
});
export const updateEntrySchema = updateExpenseSchema
  .omit({ expenseId: true })
  .extend({ entryId: z.uuid() });
export const deleteEntrySchema = deleteExpenseSchema
  .omit({ expenseId: true })
  .extend({ entryId: z.uuid() });
export const filterSchema = z
  .strictObject({
    type: entryTypeSchema.optional(),
    recurringId: z.uuid().optional(),
    paymentStatus: paymentStatusSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    category: categorySchema.optional(),
    currency: currencySchema.optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Literal description substring; ignores case and common Spanish accents.'),
    minAmount: amountSchema.optional(),
    maxAmount: amountSchema.optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'from must be on or before to.')
  .refine(
    (v) => !v.minAmount || !v.maxAmount || toMinor(v.minAmount) <= toMinor(v.maxAmount),
    'minAmount must be no greater than maxAmount.',
  );
export const listExpenseSchema = filterSchema.safeExtend({
  deleted: z.enum(['exclude', 'include', 'only']).default('exclude'),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
});
export const expenseSchema = z.strictObject({
  source: recordingSourceSchema.default('user'),
  paymentStatus: paymentStatusSchema.default('confirmed'),
  type: entryTypeSchema.default('expense'),
  recurringId: z.uuid().nullable().default(null),
  occurrenceDate: dateSchema.nullable().default(null),
  id: z.uuid(),
  description: descriptionSchema,
  amount: z.string(),
  amountMinor: z.string().regex(/^\d+$/),
  currency: currencySchema,
  date: dateSchema,
  category: categorySchema,
  version: z.number().int().positive(),
  deletedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Expense = z.infer<typeof expenseSchema>;
export type CreateExpense = z.infer<typeof createExpenseSchema>;
export type UpdateExpense = z.infer<typeof updateExpenseSchema>;
export type DeleteExpense = z.infer<typeof deleteExpenseSchema>;
export const restoreEntrySchema = deleteEntrySchema.extend({
  duplicateConfirmation: duplicateConfirmationSchema.optional(),
});
export type Filter = z.infer<typeof filterSchema>;
export type ListExpenses = z.input<typeof listExpenseSchema>;
export type ParsedListExpenses = z.output<typeof listExpenseSchema>;
export const cursorSchema = z.strictObject({ date: dateSchema, id: z.uuid() });
export type Cursor = z.infer<typeof cursorSchema>;

export class LedgerError extends Error {
  readonly code:
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'AMBIGUOUS_TARGET'
    | 'ALREADY_DELETED'
    | 'IDEMPOTENCY_CONFLICT'
    | 'INVALID_INPUT'
    | 'POSSIBLE_DUPLICATE';

  readonly details?: Record<string, unknown>;

  constructor(code: LedgerError['code'], message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function toMinor(amount: string): number {
  const [whole, fraction = ''] = amountSchema.parse(amount).split('.');
  return Number(BigInt(whole ?? '0') * 100n + BigInt(fraction.padEnd(2, '0')));
}

export function formatMinor(minor: string | bigint): string {
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function todayInMexico(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
