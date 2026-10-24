import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics';
import type { LedgerStore } from '../expenses/store';
import { toolResult, type Principal } from './results';
import {
  createExpenseSchema,
  currencySchema,
  deleteExpenseSchema,
  expenseSchema,
  filterSchema,
  listExpenseSchema,
  updateExpenseSchema,
} from '../domain/expense';
import { exportSchema } from '../domain/insights';
import { exportEntryPage } from '../expenses/queries';
import {
  createExpense,
  deleteExpense,
  getExpenseSummary,
  listExpenses,
  updateExpense,
} from '../expenses/service';
import { readAnnotations, writeAnnotations, expenseExportOutput } from './contracts';

const createExpenseInputSchema = createExpenseSchema.safeExtend({
  type: z.literal('expense').default('expense'),
});

const expenseOutput = z.object({ expense: expenseSchema });

const listExpensesInputSchema = listExpenseSchema.safeExtend({
  type: z.literal('expense').optional(),
});

const listExpensesOutputSchema = z.object({
  expenses: z.array(expenseSchema),
  nextCursor: z.string().nullable(),
});

const getExpenseSummaryInputSchema = filterSchema.safeExtend({
  type: z.literal('expense').optional(),
});

const getExpenseSummaryOutputSchema = z.object({
  totals: z.array(
    z.object({
      currency: currencySchema,
      amountMinor: z.string(),
      amount: z.string(),
      count: z.number().int(),
      unverifiedCount: z.number().int(),
    }),
  ),
});

export function registerExpenses(
  server: McpServer,
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  server.registerTool(
    'create_expense',
    {
      description:
        'Record one confirmed expense for the signed-in user. Amount is a positive decimal string; currency and category are required. Infer the closest category when confident and ask the user when torn between two. Omitted date means today in Mexico City. Reuse the same idempotency key only for retries.',
      inputSchema: createExpenseInputSchema,
      outputSchema: expenseOutput,
      annotations: writeAnnotations,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['expenses:read', 'expenses:write'] }] },
    },
    (input) =>
      toolResult(
        principal,
        'expenses:write',
        async () => ({
          expense: await createExpense(store, principal.userId, input),
        }),
        diagnostics,
      ),
  );
  server.registerTool(
    'list_expenses',
    {
      description:
        'Search persisted expenses by description substring and amount range, newest date first. Date and amount filters are inclusive. Use nextCursor with the same filters for another bounded page; never use conversation memory as the ledger.',
      inputSchema: listExpensesInputSchema,
      outputSchema: listExpensesOutputSchema,
      annotations: readAnnotations,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['expenses:read'] }] },
    },
    (input) =>
      toolResult(
        principal,
        'expenses:read',
        () => listExpenses(store, principal.userId, { ...input, type: 'expense' }),
        diagnostics,
      ),
  );
  server.registerTool(
    'update_expense',
    {
      description:
        'Correct only an expense unambiguously identified by the user. List first. Supply match with existing-record facts the USER provided or confirmed; never copy distinguishing facts from an arbitrarily chosen candidate. The server rejects multiple matching records even with a valid expenseId. Ask for distinguishing facts on AMBIGUOUS_TARGET or missing context; do not guess recency, list order, currency or prior amount. An exact user-confirmed description/date/old amount can disambiguate without an extra confirmation. Use the selected ID and expectedVersion from the list. Audited. Retry identical input/key.',
      inputSchema: updateExpenseSchema,
      outputSchema: expenseOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['expenses:read', 'expenses:write'] }] },
    },
    (input) =>
      toolResult(
        principal,
        'expenses:write',
        async () => ({
          expense: await updateExpense(store, principal.userId, {
            ...input,
            match: { ...input.match, type: 'expense' },
          }),
        }),
        diagnostics,
      ),
  );
  server.registerTool(
    'delete_expense',
    {
      description:
        'Soft-delete one expense unambiguously identified by the user. List first. Supply match with existing-record facts the USER provided or confirmed; the server rejects multiple matching records even with a valid expenseId. Use the selected ID and expectedVersion from the list. The record is removed from lists and totals but kept in the audit history; restore_entry can undo an explicitly selected deletion, so confirm the user truly wants it gone before calling. Audited. Retry identical input/key.',
      inputSchema: deleteExpenseSchema,
      outputSchema: expenseOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['expenses:read', 'expenses:write'] }] },
    },
    (input) =>
      toolResult(
        principal,
        'expenses:write',
        async () => ({
          expense: await deleteExpense(store, principal.userId, {
            ...input,
            match: { ...input.match, type: 'expense' },
          }),
        }),
        diagnostics,
      ),
  );
  server.registerTool(
    'get_expense_summary',
    {
      description:
        'Calculate exact totals from recorded expenses, including automatic charges, grouped by currency. unverifiedCount reports automatically recorded entries awaiting confirmation. Inclusive date range and category/currency filters; an empty totals array means no matches. Never sum different currencies.',
      inputSchema: getExpenseSummaryInputSchema,
      outputSchema: getExpenseSummaryOutputSchema,
      annotations: readAnnotations,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['expenses:read'] }] },
    },
    (input) =>
      toolResult(
        principal,
        'expenses:read',
        () => getExpenseSummary(store, principal.userId, { ...input, type: 'expense' }),
        diagnostics,
      ),
  );
  server.registerTool(
    'export_expenses',
    {
      description:
        'Export a bounded page of expenses, including soft-deleted records, as JSON or CSV. count is this page count; follow nextCursor until null with the same format. CSV is generated by the server. Live pages are not a frozen snapshot. Use export_backup with ledger permission for all financial data and history.',
      inputSchema: exportSchema,
      outputSchema: expenseExportOutput,
      annotations: readAnnotations,
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['expenses:read'] }] },
    },
    (input) =>
      toolResult(
        principal,
        'expenses:read',
        async () => {
          const { entries, ...result } = await exportEntryPage(
            store,
            principal.userId,
            input,
            'expense',
          );
          return entries ? { ...result, expenses: entries } : result;
        },
        diagnostics,
      ),
  );
}
