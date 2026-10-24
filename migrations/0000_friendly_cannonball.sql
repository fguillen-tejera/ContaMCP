CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`description` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`date` text NOT NULL,
	`category` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "positive_exact_amount" CHECK(typeof("expenses"."amount_minor") = 'integer' AND "expenses"."amount_minor" BETWEEN 1 AND 999999999999),
	CONSTRAINT "valid_currency" CHECK("expenses"."currency" IN ('MXN', 'USD', 'EUR')),
	CONSTRAINT "valid_description" CHECK(length(trim("expenses"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "positive_version" CHECK(typeof("expenses"."version") = 'integer' AND "expenses"."version" > 0),
	CONSTRAINT "valid_category" CHECK("expenses"."category" IS NULL OR "expenses"."category" IN ('food_drink', 'groceries', 'transport', 'shopping', 'entertainment', 'education', 'bills_services', 'health', 'home', 'pets', 'travel', 'other')),
	CONSTRAINT "valid_date" CHECK("expenses"."date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND "expenses"."date" BETWEEN '1900-01-01' AND '9999-12-31' AND date("expenses"."date", '+0 days') IS NOT NULL AND date("expenses"."date", '+0 days') = "expenses"."date")
);
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mutation_expense_version` ON `expense_mutations` (`expense_id`,`version`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`google_subject` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_google_subject_unique` ON `users` (`google_subject`);