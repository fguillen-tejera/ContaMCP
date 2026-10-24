import { z } from 'zod';
import { expenseSchema } from '../domain/expense';
import { exportSchema } from '../domain/insights';

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

export const entryOutput = z.object({ entry: expenseSchema });

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
