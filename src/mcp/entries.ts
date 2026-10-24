import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics';
import type { LedgerStore } from '../expenses/store';
import { toolResult, type Principal } from './results';
import {
  createExpenseSchema,
  entryTypeSchema,
  currencySchema,
  expenseSchema,
  filterSchema,
  listExpenseSchema,
  updateEntrySchema,
  deleteEntrySchema,
} from '../domain/expense';
import { exportSchema } from '../domain/insights';
import { exportEntryPage } from '../expenses/queries';
import {
  createExpense,
  deleteExpense,
  getCashFlow,
  listExpenses,
  updateExpense,
} from '../expenses/service';
import {
  readAnnotations,
  writeAnnotations,
  ledgerSecurity,
  entryOutput,
  entryExportOutput,
} from './contracts';

const createEntryInputSchema = createExpenseSchema.safeExtend({ type: entryTypeSchema });

const listEntriesOutputSchema = z.object({
  entries: z.array(expenseSchema),
  nextCursor: z.string().nullable(),
});

const getCashFlowInputSchema = filterSchema.safeExtend({ type: z.never().optional() });

const getCashFlowOutputSchema = z.object({
  totals: z.array(
    z.object({
      currency: currencySchema,
      income: z.string(),
      expenses: z.string(),
      net: z.string(),
      unverifiedCount: z.number().int(),
    }),
  ),
});

export function registerEntries(
  server: McpServer,
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  server.registerTool(
    'create_entry',
    {
      description:
        'Record confirmed income or expense. Explicit type/currency/category, positive decimal amount. Possible duplicates pause saving: ask the user, then acknowledge returned IDs/versions only for a confirmed separate entry. If recurrence is explicit, create the user-established schedule with automatic recording by default and state the recurring behavior; otherwise ask once whether it repeats. If a duplicate candidate is the matching automatic occurrence, reconcile that occurrence after user-reported payment instead of creating another entry. Own-account transfers are not income or expenses.',
      inputSchema: createEntryInputSchema,
      outputSchema: entryOutput,
      annotations: writeAnnotations,
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ entry: await createExpense(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'list_entries',
    {
      description:
        'Search persisted income and expenses by description substring, amount range, type/date/category/currency and payment status. deleted=only finds records for explicit restoration. Use nextCursor with unchanged filters. Read first before corrections or payment linking.',
      inputSchema: listExpenseSchema,
      outputSchema: listEntriesOutputSchema,
      annotations: readAnnotations,
      _meta: ledgerSecurity('ledger:read'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        async () => {
          const result = await listExpenses(store, principal.userId, input);
          return { entries: result.expenses, nextCursor: result.nextCursor };
        },
        diagnostics,
      ),
  );
  server.registerTool(
    'update_entry',
    {
      description:
        'Correct a user-identified income or expense. List first; match facts must come from the user. Multiple matches are rejected. Use current expectedVersion and retry key. Type cannot be changed: delete/recreate a misclassified entry after confirmation.',
      inputSchema: updateEntrySchema,
      outputSchema: entryOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({
          entry: await updateExpense(store, principal.userId, {
            expenseId: input.entryId,
            expectedVersion: input.expectedVersion,
            match: input.match,
            changes: input.changes,
            idempotencyKey: input.idempotencyKey,
          }),
        }),
        diagnostics,
      ),
  );
  server.registerTool(
    'delete_entry',
    {
      description:
        'Soft-delete an explicitly user-confirmed income or expense. List first and supply exact identifying facts and expectedVersion. Retains audit history. Deleting a recurring payment does not reopen its schedule occurrence.',
      inputSchema: deleteEntrySchema,
      outputSchema: entryOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({
          entry: await deleteExpense(store, principal.userId, {
            expenseId: input.entryId,
            expectedVersion: input.expectedVersion,
            match: input.match,
            idempotencyKey: input.idempotencyKey,
          }),
        }),
        diagnostics,
      ),
  );
  server.registerTool(
    'get_cash_flow',
    {
      description:
        'Exact recorded income, expenses, and net by currency with inclusive date/category filters. Includes automatically recorded charges; unverifiedCount identifies entries not yet confirmed by the user. paymentStatus can filter them. Net is income minus expenses, not an account balance, net worth, or saved money. Excludes future recurring expectations and savings allocations.',
      inputSchema: getCashFlowInputSchema,
      outputSchema: getCashFlowOutputSchema,
      annotations: readAnnotations,
      _meta: ledgerSecurity('ledger:read'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => getCashFlow(store, principal.userId, input),
        diagnostics,
      ),
  );
  server.registerTool(
    'export_entries',
    {
      description:
        'Export a bounded page of income and expenses including deleted records as JSON or CSV. Follow nextCursor until null; count is the current page count. Live pages are not a frozen snapshot. Use export_backup for schedules, goals, budgets, preferences and original history.',
      inputSchema: exportSchema,
      outputSchema: entryExportOutput,
      annotations: readAnnotations,
      _meta: ledgerSecurity('ledger:read'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => exportEntryPage(store, principal.userId, input),
        diagnostics,
      ),
  );
}
