import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics';
import type { LedgerStore } from '../expenses/store';
import { currencySchema, restoreEntrySchema } from '../domain/expense';
import {
  backupDatasetSchema,
  backupSchema,
  budgetSchema,
  historySchema,
  listBudgetsSchema,
  preferencesSchema,
  reportSchema,
  setBudgetSchema,
  setPreferencesSchema,
} from '../domain/insights';
import { exportBackup, getActivityHistory, getLedgerReport } from '../expenses/queries';
import { restoreEntry } from '../expenses/service';
import {
  getPreferences,
  listMonthlyBudgets,
  setMonthlyBudget,
  setPreferences,
} from '../planning/budgets';
import { toolResult, type Principal } from './results';
import { entryOutput } from './contracts';

const read = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const write = { ...read, readOnlyHint: false, destructiveHint: true };
const readSecurity = { securitySchemes: [{ type: 'oauth2', scopes: ['ledger:read'] }] };
const writeSecurity = {
  securitySchemes: [{ type: 'oauth2', scopes: ['ledger:read', 'ledger:write'] }],
};
const empty = z.strictObject({});
const totals = z.array(
  z.object({
    currency: currencySchema,
    income: z.string(),
    expenses: z.string(),
    net: z.string(),
    unverifiedCount: z.number().int(),
  }),
);
const period = z.object({
  from: z.string(),
  to: z.string(),
  totals,
  groups: z.array(
    z.object({
      bucket: z.string(),
      type: z.enum(['income', 'expense']),
      currency: currencySchema,
      amount: z.string(),
      amountMinor: z.string(),
      count: z.number().int(),
      unverifiedCount: z.number().int(),
    }),
  ),
});
const reportOutput = z.object({
  groupBy: z.enum(['category', 'month']),
  timezone: z.string(),
  current: period,
  previous: period.nullable(),
  changes: z.array(
    z.object({
      currency: currencySchema,
      incomeDifference: z.string(),
      expenseDifference: z.string(),
      netDifference: z.string(),
    }),
  ),
});
const historyOutput = z.object({
  activity: z.array(
    z.object({
      version: z.number().int(),
      recordedAt: z.string(),
      before: z.unknown(),
      after: z.unknown(),
      details: z.record(z.string(), z.unknown()),
    }),
  ),
  nextAfterVersion: z.number().int().nullable(),
});
const preferencesOutput = z.object({
  defaultCurrency: currencySchema.nullable(),
  version: z.number().int(),
  timezone: z.string(),
});
const savedPreferencesOutput = z.object({ preferences: preferencesSchema });
const savedBudgetOutput = z.object({ budget: budgetSchema });
const budgetsOutput = z.object({
  month: z.string(),
  timezone: z.string(),
  budgets: z.array(
    budgetSchema.extend({
      spentAmount: z.string(),
      confirmedSpentAmount: z.string(),
      unverifiedAmount: z.string(),
      remainingAmount: z.string(),
      overBudget: z.boolean(),
      count: z.number().int(),
    }),
  ),
});
const backupOutput = z.object({
  dataset: backupDatasetSchema,
  exportedAt: z.string(),
  consistency: z.literal('live'),
  count: z.number().int(),
  records: z.array(z.record(z.string(), z.unknown())),
  nextCursor: z.string().nullable(),
});
export function registerInsights(
  server: McpServer,
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  server.registerTool(
    'get_ledger_report',
    {
      description:
        'Exact category or month breakdown of recorded income/expenses for an inclusive range of at most 366 days. Optionally compare the immediately preceding equal-length period. Currencies stay separate; unverifiedCount includes automatic records awaiting confirmation. Use this instead of fetching and adding pages. Not an account balance.',
      inputSchema: reportSchema,
      outputSchema: reportOutput,
      annotations: read,
      _meta: readSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => getLedgerReport(store, principal.userId, input),
        diagnostics,
      ),
  );
  server.registerTool(
    'get_activity_history',
    {
      description:
        'Read stored before/after versions and contribution details for a user-selected entry, recurring schedule, savings goal, or budget. Includes deletions. Page with nextAfterVersion. Empty activity means no matching accessible history.',
      inputSchema: historySchema,
      outputSchema: historyOutput,
      annotations: read,
      _meta: readSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => getActivityHistory(store, principal.userId, input),
        diagnostics,
      ),
  );
  server.registerTool(
    'restore_entry',
    {
      description:
        'Restore an explicitly user-selected deleted entry. List entries with deleted=only first, obtain current ID/version and user-supplied identifying match facts. Preserves its history and recurring association without advancing or reopening a schedule. Possible duplicate confirmation requires asking the user.',
      inputSchema: restoreEntrySchema,
      outputSchema: entryOutput,
      annotations: write,
      _meta: writeSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ entry: await restoreEntry(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'get_preferences',
    {
      description:
        'Read the user-approved default currency across conversations. null means no default: clarify an unknown currency. Explicit transaction currency overrides the default. Calendar timezone is America/Mexico_City.',
      inputSchema: empty,
      outputSchema: preferencesOutput,
      annotations: read,
      _meta: readSecurity,
    },
    () =>
      toolResult(
        principal,
        'ledger:read',
        () => getPreferences(store, principal.userId),
        diagnostics,
      ),
  );
  server.registerTool(
    'set_preferences',
    {
      description:
        'Remember or clear a default currency only when the user explicitly asks. Read current preferences/version first; version 0 creates the initial preference. Never infer a default from a transaction or country. Audited and retry-safe.',
      inputSchema: setPreferencesSchema,
      outputSchema: savedPreferencesOutput,
      annotations: write,
      _meta: writeSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ preferences: await setPreferences(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'set_monthly_budget',
    {
      description:
        'Only on user request: set a spending limit for one explicit calendar month (YYYY-MM), category, and currency. List that month first and use its current version, or 0 for a new limit. active=false archives it. No rollover, automatic renewals, alerts, or financial writes to the ledger.',
      inputSchema: setBudgetSchema,
      outputSchema: savedBudgetOutput,
      annotations: write,
      _meta: writeSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ budget: await setMonthlyBudget(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'list_monthly_budgets',
    {
      description:
        'Compare user-set monthly category limits with exact live recorded expenses. Income, deleted records, and savings allocations are excluded. spentAmount includes automatic unverified charges, shown separately as unverifiedAmount; remainingAmount may be negative. No limits are invented when the list is empty.',
      inputSchema: listBudgetsSchema,
      outputSchema: budgetsOutput,
      annotations: read,
      _meta: readSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => listMonthlyBudgets(store, principal.userId, input),
        diagnostics,
      ),
  );
  server.registerTool(
    'export_backup',
    {
      description:
        'User-requested complete financial backup: export each dataset (entries, recurring, goals, budgets, preferences, entry_history, planning_history, account_history), following every nextCursor. Includes inactive/deleted records and original audit/retry receipts. Excludes login credentials and identity. Bounded live pages, not a transactionally frozen snapshot; pause writes for a consistent backup. No import/restore operation is performed.',
      inputSchema: backupSchema,
      outputSchema: backupOutput,
      annotations: read,
      _meta: readSecurity,
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => exportBackup(store, principal.userId, input),
        diagnostics,
      ),
  );
}
