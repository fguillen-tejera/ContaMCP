import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { Diagnostics } from '../diagnostics';
import type { LedgerStore } from '../expenses/store';
import type { Principal } from './results';
import { registerExpenses } from './expenses';
import { registerEntries } from './entries';
import { registerRecurring } from './recurring';
import { registerGoals } from './goals';
import { registerInsights } from './insights';

export function expenseMcpServer(
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  const server = new McpServer(
    { name: 'contamcp', version: '0.1.0' },
    {
      instructions:
        "ContaMCP stores income and expenses across conversations. Prefer create_entry/list_entries for new income and expense workflows. Legacy expense tools use separate expense-only permissions. Transfers between your own accounts are neither income nor expenses; clarify refunds. On POSSIBLE_DUPLICATE, present candidates and ask whether this is a separate entry; supply duplicateConfirmation only after the user confirms. A user who explicitly establishes a subscription or recurring income/expense authorizes automatic recording by default: ask only for missing amount, currency, frequency, or first billing date, and state that it will be recorded each period. Do not ask a second question about automation. If a single expense merely looks like a subscription, ask once whether it repeats before creating a schedule. Automatically recorded entries count in totals and have source recurring/paymentStatus unverified: never claim bank payment was verified. When unverifiedCount is nonzero in a summary, state briefly that the total includes automatically recorded entries. Before creating a reported payment for a known subscription, check its recurring payment history even when the actual amount differs. On a later report of the same payment, reconcile its automatic entry with confirm_recurring_payment using the existing entry ID/version and occurrenceDate; never create a second expense. Users may choose manual recording, pause/resume, skip, or change terms. Use confirm_recurring_payment only after actual payment or receipt is reported. No money is moved and no reminders are sent. Savings contributions are explicit allocations, never additional expenses or inferred cash-flow savings. Never infer records from chat memory. Ask about ambiguous amount, currency, date, or correction target. Before correcting, list matching records. If more than one record matches the user's words, ask the user to choose before any write; never choose by recency, list position, or the last record mentioned. Use the chosen record's returned ID/version. Use decimal strings, explicit currency, and a fresh idempotency key for each intended mutation; reuse the key and identical input on retries. Category is required on every expense: infer the closest category when confident, ask the user when torn between two, and use other only when nothing fits. Prefer correcting a wrong expense over deleting it; delete only on an explicit user request, confirmed. When currency is unspecified, read get_preferences and use its explicitly approved default; null requires clarification. Save preferences or monthly category budgets only on explicit user request. Prefer get_ledger_report for category/month comparisons. Follow every nextCursor for exports; export_backup covers all financial datasets and audits. Categories are bookkeeping labels, not tax advice.",
    },
  );
  registerExpenses(server, store, principal, diagnostics);
  registerEntries(server, store, principal, diagnostics);
  registerRecurring(server, store, principal, diagnostics);
  registerGoals(server, store, principal, diagnostics);
  registerInsights(server, store, principal, diagnostics);
  return server;
}

export function handleMcp(
  request: Request,
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  return createMcpHandler(() => expenseMcpServer(store, principal, diagnostics), {
    legacy: 'stateless',
    maxRequestBodySize: 16_384,
  }).fetch(request);
}
