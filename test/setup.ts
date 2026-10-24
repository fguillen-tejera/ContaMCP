import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_mutations'),
    env.DB.prepare('DELETE FROM monthly_budgets'),
    env.DB.prepare('DELETE FROM user_preferences'),
    env.DB.prepare('DELETE FROM expense_mutations'),
    env.DB.prepare('DELETE FROM expenses'),
    env.DB.prepare('DELETE FROM planning_mutations'),
    env.DB.prepare('DELETE FROM recurring_entries'),
    env.DB.prepare('DELETE FROM savings_goals'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});
