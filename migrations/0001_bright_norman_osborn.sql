-- Rebuild of `expenses` for the required category. D1 always enforces foreign keys
-- (PRAGMA foreign_keys=OFF is ignored), so the rebuild keeps every parent/child
-- relationship satisfied at each statement: mutations are backed up FK-free, both
-- tables are dropped child-first, and the audit rows are restored afterwards.
CREATE TABLE `__new_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`description` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`date` text NOT NULL,
	`category` text NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "positive_exact_amount" CHECK(typeof("__new_expenses"."amount_minor") = 'integer' AND "__new_expenses"."amount_minor" BETWEEN 1 AND 999999999999),
	CONSTRAINT "valid_currency" CHECK("__new_expenses"."currency" IN ('MXN', 'USD', 'EUR')),
	CONSTRAINT "valid_description" CHECK(length(trim("__new_expenses"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "positive_version" CHECK(typeof("__new_expenses"."version") = 'integer' AND "__new_expenses"."version" > 0),
	CONSTRAINT "valid_category" CHECK("__new_expenses"."category" IN ('food_drink', 'groceries', 'transport', 'shopping', 'entertainment', 'education', 'bills_services', 'health', 'home', 'pets', 'travel', 'other')),
	CONSTRAINT "valid_date" CHECK("__new_expenses"."date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "__new_expenses"."date" BETWEEN '1900-01-01' AND '9999-12-31' AND date("__new_expenses"."date", '+0 days') IS NOT NULL AND date("__new_expenses"."date", '+0 days') = "__new_expenses"."date")
);--> statement-breakpoint
INSERT INTO `__new_expenses`("id", "owner_id", "description", "amount_minor", "currency", "date", "category", "version", "created_at", "updated_at") SELECT "id", "owner_id", "description", "amount_minor", "currency", "date", "category", "version", "created_at", "updated_at" FROM `expenses`;--> statement-breakpoint
CREATE TABLE `__backup_mutations` (
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`expense_id` text NOT NULL,
	`version` integer NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `idempotency_key`)
);--> statement-breakpoint
INSERT INTO `__backup_mutations`("owner_id", "idempotency_key", "request_hash", "expense_id", "version", "before_json", "after_json", "created_at") SELECT "owner_id", "idempotency_key", "request_hash", "expense_id", "version", "before_json", "after_json", "created_at" FROM `expense_mutations`;--> statement-breakpoint
DROP TABLE `expense_mutations`;--> statement-breakpoint
DROP TABLE `expenses`;--> statement-breakpoint
ALTER TABLE `__new_expenses` RENAME TO `expenses`;--> statement-breakpoint
CREATE UNIQUE INDEX `expense_owner_id` ON `expenses` (`owner_id`,`id`);--> statement-breakpoint
CREATE INDEX `expense_owner_date_id` ON `expenses` (`owner_id`,`date`,`id`);--> statement-breakpoint
CREATE INDEX `expense_owner_category_date` ON `expenses` (`owner_id`,`category`,`date`);--> statement-breakpoint
CREATE TABLE `expense_mutations` (
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`expense_id` text NOT NULL,
	`version` integer NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `idempotency_key`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`expense_id`) REFERENCES `expenses`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mutation_positive_version" CHECK("expense_mutations"."version" > 0)
);--> statement-breakpoint
INSERT INTO `expense_mutations`("owner_id", "idempotency_key", "request_hash", "expense_id", "version", "before_json", "after_json", "created_at") SELECT "owner_id", "idempotency_key", "request_hash", "expense_id", "version", "before_json", "after_json", "created_at" FROM `__backup_mutations`;--> statement-breakpoint
DROP TABLE `__backup_mutations`;--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_expense_version` ON `expense_mutations` (`expense_id`,`version`);
