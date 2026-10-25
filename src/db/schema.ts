import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { Goal, Recurring } from '../domain/planning';
import type { Expense } from '../domain/expense';
import type { Budget, Preferences } from '../domain/insights';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  googleSubject: text('google_subject').notNull().unique(),
  createdAt: text('created_at').notNull(),
});

export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    source: text('source', { enum: ['user', 'recurring'] })
      .notNull()
      .default('user'),
    paymentStatus: text('payment_status', { enum: ['confirmed', 'unverified'] })
      .notNull()
      .default('confirmed'),
    type: text('type', { enum: ['expense', 'income'] })
      .notNull()
      .default('expense'),
    recurringId: text('recurring_id'),
    occurrenceDate: text('occurrence_date'),
    description: text('description').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency', { enum: ['MXN', 'USD', 'EUR'] }).notNull(),
    date: text('date').notNull(),
    category: text('category', {
      enum: [
        'food_drink',
        'groceries',
        'transport',
        'shopping',
        'entertainment',
        'education',
        'bills_services',
        'health',
        'home',
        'pets',
        'travel',
        'other',
      ],
    }).notNull(),
    version: integer('version').notNull(),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check('valid_recording_source', sql`${table.source} IN ('user', 'recurring')`),
    check(
      'valid_payment_status',
      sql`${table.paymentStatus} IN ('confirmed', 'unverified') AND (${table.paymentStatus} = 'confirmed' OR (${table.source} = 'recurring' AND ${table.recurringId} IS NOT NULL))`,
    ),
    check('valid_entry_type', sql`${table.type} IN ('expense', 'income')`),
    check(
      'valid_occurrence',
      sql`(${table.recurringId} IS NULL AND ${table.occurrenceDate} IS NULL) OR (${table.recurringId} IS NOT NULL AND ${table.occurrenceDate} IS NOT NULL)`,
    ),
    uniqueIndex('entry_recurring_occurrence').on(
      table.ownerId,
      table.recurringId,
      table.occurrenceDate,
    ),
    index('entry_duplicate_lookup').on(table.ownerId, table.type, table.currency, table.date),
    uniqueIndex('expense_owner_id').on(table.ownerId, table.id),
    index('expense_owner_date_id').on(table.ownerId, table.date, table.id),
    index('expense_owner_created_id').on(table.ownerId, table.createdAt, table.id),
    index('expense_owner_category_date').on(table.ownerId, table.category, table.date),
    check(
      'positive_exact_amount',
      sql`typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} BETWEEN 1 AND 999999999999`,
    ),
    check('valid_currency', sql`${table.currency} IN ('MXN', 'USD', 'EUR')`),
    check('valid_description', sql`length(trim(${table.description})) BETWEEN 1 AND 500`),
    check('positive_version', sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`),
    check(
      'valid_category',
      sql`${table.category} IN ('food_drink', 'groceries', 'transport', 'shopping', 'entertainment', 'education', 'bills_services', 'health', 'home', 'pets', 'travel', 'other')`,
    ),
    check(
      'valid_date',
      sql`${table.date} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ${table.date} BETWEEN '1900-01-01' AND '9999-12-31' AND date(${table.date}, '+0 days') IS NOT NULL AND date(${table.date}, '+0 days') = ${table.date}`,
    ),
  ],
);

// This is both the retry receipt and the financial audit history; never expire it independently.
export const mutations = sqliteTable(
  'expense_mutations',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    key: text('idempotency_key').notNull(),
    hash: text('request_hash').notNull(),
    expenseId: text('expense_id').notNull(),
    version: integer('version').notNull(),
    before: text('before_json', { mode: 'json' }).$type<Expense | null>(),
    after: text('after_json', { mode: 'json' }).$type<Expense>().notNull(),
    // The chain detects inconsistent retained history; it has no external trusted anchor.
    prevHash: text('prev_hash'),
    entryHash: text('entry_hash'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.key] }),
    uniqueIndex('mutation_expense_version').on(table.expenseId, table.version),
    foreignKey({
      columns: [table.ownerId, table.expenseId],
      foreignColumns: [expenses.ownerId, expenses.id],
    }),
    check('mutation_positive_version', sql`${table.version} > 0`),
  ],
);

export const recurringEntries = sqliteTable(
  'recurring_entries',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull(),
    data: text('data', { mode: 'json' }).$type<Recurring>().notNull(),
  },
  (table) => [
    index('recurring_owner_id').on(table.ownerId, table.id),
    index('recurring_automatic_due')
      .on(sql`json_extract(${table.data}, '$.nextDate')`, table.id)
      .where(
        sql`json_extract(${table.data}, '$.active') = 1 AND json_extract(${table.data}, '$.automatic') = 1 AND COALESCE(json_extract(${table.data}, '$.needsReview'), 0) = 0`,
      ),
    check(
      'recurring_valid_data',
      sql`json_valid(${table.data}) AND json_extract(${table.data}, '$.id') = ${table.id} AND json_extract(${table.data}, '$.version') = ${table.version} AND ${table.version} > 0`,
    ),
  ],
);

export const savingsGoals = sqliteTable(
  'savings_goals',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    version: integer('version').notNull(),
    data: text('data', { mode: 'json' }).$type<Goal>().notNull(),
  },
  (table) => [
    index('goal_owner_id').on(table.ownerId, table.id),
    check(
      'goal_valid_data',
      sql`json_valid(${table.data}) AND json_extract(${table.data}, '$.id') = ${table.id} AND json_extract(${table.data}, '$.version') = ${table.version} AND ${table.version} > 0`,
    ),
    check(
      'goal_exact_balance',
      sql`CAST(CAST(json_extract(${table.data}, '$.savedMinor') AS INTEGER) AS TEXT) = json_extract(${table.data}, '$.savedMinor') AND CAST(json_extract(${table.data}, '$.savedMinor') AS INTEGER) BETWEEN 0 AND 999999999999`,
    ),
  ],
);

export const planningMutations = sqliteTable(
  'planning_mutations',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    key: text('idempotency_key').notNull(),
    hash: text('request_hash').notNull(),
    kind: text('kind', { enum: ['recurring', 'goal'] }).notNull(),
    entityId: text('entity_id').notNull(),
    version: integer('version').notNull(),
    before: text('before_json', { mode: 'json' }).$type<Recurring | Goal | null>(),
    after: text('after_json', { mode: 'json' }).$type<Recurring | Goal>().notNull(),
    details: text('details_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.key] }),
    uniqueIndex('planning_entity_version').on(
      table.ownerId,
      table.kind,
      table.entityId,
      table.version,
    ),
    check('planning_positive_version', sql`${table.version} > 0`),
  ],
);

export const monthlyBudgets = sqliteTable(
  'monthly_budgets',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    month: text('month').notNull(),
    category: text('category').$type<Expense['category']>().notNull(),
    currency: text('currency', { enum: ['MXN', 'USD', 'EUR'] }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull(),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('budget_owner_month_category_currency').on(
      table.ownerId,
      table.month,
      table.category,
      table.currency,
    ),
    check(
      'budget_exact_limit',
      sql`typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} BETWEEN 1 AND 999999999999`,
    ),
    check(
      'budget_valid_month',
      sql`${table.month} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND ${table.month} BETWEEN '1900-01' AND '9999-12' AND substr(${table.month}, 6, 2) BETWEEN '01' AND '12'`,
    ),
    check('budget_valid_currency', sql`${table.currency} IN ('MXN', 'USD', 'EUR')`),
    check(
      'budget_valid_category',
      sql`${table.category} IN ('food_drink', 'groceries', 'transport', 'shopping', 'entertainment', 'education', 'bills_services', 'health', 'home', 'pets', 'travel', 'other')`,
    ),
    check(
      'budget_valid_version',
      sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`,
    ),
    check('budget_valid_active', sql`${table.active} IN (0, 1)`),
  ],
);
export const userPreferences = sqliteTable(
  'user_preferences',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .unique()
      .references(() => users.id),
    defaultCurrency: text('default_currency', { enum: ['MXN', 'USD', 'EUR'] }),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    check(
      'preferences_valid_currency',
      sql`${table.defaultCurrency} IS NULL OR ${table.defaultCurrency} IN ('MXN', 'USD', 'EUR')`,
    ),
    check(
      'preferences_valid_version',
      sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`,
    ),
  ],
);
export const accountMutations = sqliteTable(
  'account_mutations',
  {
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    key: text('idempotency_key').notNull(),
    hash: text('request_hash').notNull(),
    kind: text('kind', { enum: ['budget', 'preferences'] }).notNull(),
    entityId: text('entity_id').notNull(),
    version: integer('version').notNull(),
    before: text('before_json', { mode: 'json' }).$type<Budget | Preferences | null>(),
    after: text('after_json', { mode: 'json' }).$type<Budget | Preferences>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.key] }),
    uniqueIndex('account_entity_version').on(
      table.ownerId,
      table.kind,
      table.entityId,
      table.version,
    ),
    check('account_valid_kind', sql`${table.kind} IN ('budget', 'preferences')`),
    check(
      'account_valid_version',
      sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`,
    ),
  ],
);
