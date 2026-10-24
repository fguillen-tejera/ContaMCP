import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics';
import type { LedgerStore } from '../expenses/store';
import { toolResult, type Principal } from './results';
import {
  cancelRecurringSchema,
  confirmRecurringSchema,
  createRecurringSchema,
  listRecurringSchema,
  recurringSchema,
  updateRecurringSchema,
  skipRecurringSchema,
} from '../domain/planning';
import {
  cancelRecurring,
  confirmRecurring,
  createRecurring,
  listRecurring,
  updateRecurring,
  skipRecurring,
} from '../planning/recurring';
import { readAnnotations, writeAnnotations, ledgerSecurity, entryOutput } from './contracts';

const createRecurringEntryInputSchema = createRecurringSchema.extend({
  automatic: z.boolean().optional(),
});

const recurringOutput = z.object({ recurring: recurringSchema });

const listRecurringEntriesOutputSchema = z.object({
  recurring: z.array(recurringSchema.extend({ due: z.boolean() })),
  nextAfterId: z.string().nullable(),
  nextAfterDate: z.string().nullable(),
});

export function registerRecurring(
  server: McpServer,
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  server.registerTool(
    'create_recurring_entry',
    {
      description:
        'Create a user-established recurring income/expense. Automatic recording on billing dates is the default; ask only for missing amount/currency/frequency/first billing date and explain the recurring behavior, not an extra automation question. If inferred from a one-off payment, first ask whether it repeats. The hourly job records due amounts with an automatic/unverified label and counts them in spending. automatic=false is available on user request. No money is moved or reminders sent. Link an existing payment instead of duplicating it.',
      inputSchema: createRecurringEntryInputSchema,
      outputSchema: recurringOutput,
      annotations: writeAnnotations,
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ recurring: await createRecurring(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'list_recurring_entries',
    {
      description:
        'List recurring schedules and next due dates, with due flag in Mexico City. automatic shows recording mode; needsReview means a possible duplicate blocked the job. Resolve it by linking/confirming the existing payment, confirming a separate payment, or skipping the occurrence. Results are ordered by next due date then ID. Page using nextAfterId and nextAfterDate together; dueThrough filters due dates. Canceled schedules are included only with includeInactive. Filter list_entries by recurringId for recorded payment history; each linked entry returns occurrenceDate.',
      inputSchema: listRecurringSchema,
      outputSchema: listRecurringEntriesOutputSchema,
      annotations: readAnnotations,
      _meta: ledgerSecurity('ledger:read'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => listRecurring(store, principal.userId, input),
        diagnostics,
      ),
  );
  server.registerTool(
    'confirm_recurring_payment',
    {
      description:
        'After the user reports actual payment/receipt: reconcile an automatically recorded occurrence in place using existingEntryId, expectedEntryVersion and its occurrenceDate, actual amount and paidDate. This confirms its status without advancing the schedule twice. List the schedule for its current expectedVersion. For an unrecorded occurrence, use nextDate as occurrenceDate and advance the schedule once. If payment is already recorded, supply its user-selected existingEntryId and expectedEntryVersion to link it without creating another entry. Duplicate warning requires user confirmation, not automatic override.',
      inputSchema: confirmRecurringSchema,
      outputSchema: entryOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ entry: await confirmRecurring(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'cancel_recurring_entry',
    {
      description:
        'Stop tracking a user-selected recurring schedule using its current version. This does not cancel the merchant subscription or stop bank charges. Keeps payment history and audit receipts; no ledger entry is deleted. Use update_recurring_entry to change terms or resume tracking with an explicit next billing date.',
      inputSchema: cancelRecurringSchema,
      outputSchema: recurringOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ recurring: await cancelRecurring(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'update_recurring_entry',
    {
      description:
        'Change a listed recurring amount/description/category, automatic mode, or pause/resume with active. Use current expectedVersion. Resuming or enabling automatic mode requires nextDate today or later to avoid charging paused historical periods. Changing nextDate resets the billing-day anchor. Changes affect future occurrences, not existing ledger entries.',
      inputSchema: updateRecurringSchema,
      outputSchema: recurringOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ recurring: await updateRecurring(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'skip_recurring_occurrence',
    {
      description:
        'Skip exactly the listed next unrecorded occurrence using recurringId, expectedVersion and occurrenceDate=nextDate. Preserve the schedule and an audit receipt without creating an expense. If the requested month is already auto-recorded, explicitly delete that entry instead; never skip the following month by mistake.',
      inputSchema: skipRecurringSchema,
      outputSchema: recurringOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ recurring: await skipRecurring(store, principal.userId, input) }),
        diagnostics,
      ),
  );
}
