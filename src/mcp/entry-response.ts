import { expenseSchema } from '../domain/expense.ts';

// Acceptance probes load this contract directly in Node without a bundler.
export const entryResponseSchema = expenseSchema.omit({ createdAt: true, updatedAt: true }).strip();
