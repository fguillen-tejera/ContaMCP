import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics';
import type { LedgerStore } from '../expenses/store';
import { toolResult, type Principal } from './results';
import {
  contributeSchema,
  createGoalSchema,
  goalSchema,
  planningListSchema,
  updateGoalSchema,
} from '../domain/planning';
import { contributeToGoal, createGoal, listGoals, updateGoal } from '../planning/goals';
import { readAnnotations, writeAnnotations, ledgerSecurity } from './contracts';

const goalOutput = z.object({
  goal: goalSchema.extend({
    savedAmount: z.string(),
    remainingAmount: z.string(),
    reached: z.boolean(),
  }),
});

const listSavingsGoalsOutputSchema = z.object({
  goals: z.array(goalOutput.shape.goal),
  nextAfterId: z.string().nullable(),
});

export function registerGoals(
  server: McpServer,
  store: LedgerStore,
  principal: Principal,
  diagnostics?: Diagnostics,
) {
  server.registerTool(
    'create_savings_goal',
    {
      description:
        'Create a named savings target with explicit currency and optional deadline. Starts at zero saved; never infer contributions from income minus expenses.',
      inputSchema: createGoalSchema,
      outputSchema: goalOutput,
      annotations: writeAnnotations,
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ goal: await createGoal(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'list_savings_goals',
    {
      description:
        'List savings targets, explicitly allocated saved amounts, remaining amounts, and reached status. These are user allocations, not verified bank balances. Use nextAfterId for pagination; includeInactive includes archived goals.',
      inputSchema: planningListSchema,
      outputSchema: listSavingsGoalsOutputSchema,
      annotations: readAnnotations,
      _meta: ledgerSecurity('ledger:read'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:read',
        () => listGoals(store, principal.userId, input),
        diagnostics,
      ),
  );
  server.registerTool(
    'contribute_to_savings_goal',
    {
      description:
        'Record a user-confirmed deposit allocation or withdrawal against one listed goal using current version. Positive amount in goal currency, explicit calendar date. Does not create an expense or income. Never allocate the same savings to multiple goals without user direction. To correct a contribution, record an audited compensating withdrawal/deposit.',
      inputSchema: contributeSchema,
      outputSchema: goalOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ goal: await contributeToGoal(store, principal.userId, input) }),
        diagnostics,
      ),
  );
  server.registerTool(
    'update_savings_goal',
    {
      description:
        'Change a listed savings goal name/target/deadline or archive/reactivate with active. Use current version. Currency is immutable; savings remain preserved on archive. This never changes allocated savings or ledger entries.',
      inputSchema: updateGoalSchema,
      outputSchema: goalOutput,
      annotations: { ...writeAnnotations, destructiveHint: true },
      _meta: ledgerSecurity('ledger:write'),
    },
    (input) =>
      toolResult(
        principal,
        'ledger:write',
        async () => ({ goal: await updateGoal(store, principal.userId, input) }),
        diagnostics,
      ),
  );
}
