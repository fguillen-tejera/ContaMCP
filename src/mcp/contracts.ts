import { z } from 'zod';
import { expenseSchema } from '../domain/expense';
import { budgetSchema, exportSchema, preferencesSchema } from '../domain/insights';
import { goalSchema, recurringSchema } from '../domain/planning';

export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const ledgerSecurity = (scope: 'ledger:read' | 'ledger:write') => ({
  securitySchemes: [
    { type: 'oauth2', scopes: scope === 'ledger:write' ? ['ledger:read', scope] : [scope] },
  ],
});

// Ordinary results expose actionable records; explicit exports retain the audit timestamps.
export const entryResponseSchema = expenseSchema.omit({ createdAt: true, updatedAt: true }).strip();
export const recurringResponseSchema = recurringSchema
  .omit({ createdAt: true, updatedAt: true })
  .strip();
export const goalResponseSchema = goalSchema.omit({ createdAt: true, updatedAt: true }).strip();
export const budgetResponseSchema = budgetSchema.omit({ createdAt: true, updatedAt: true }).strip();
export const savedPreferencesResponseSchema = preferencesSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .strip();

export const entryOutput = z.object({ entry: entryResponseSchema });

export const entryExportOutput = z.object({
  exportedAt: z.string(),
  count: z.number().int(),
  nextCursor: z.string().nullable(),
  format: exportSchema.shape.format,
  consistency: z.literal('live'),
  entries: z.array(expenseSchema).optional(),
  csv: z.string().optional(),
});
export const expenseExportOutput = entryExportOutput
  .omit({ entries: true })
  .extend({ expenses: z.array(expenseSchema).optional() });
