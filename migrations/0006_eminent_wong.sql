CREATE TABLE `account_mutations` (
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `idempotency_key`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_valid_kind" CHECK("account_mutations"."kind" IN ('budget', 'preferences')),
	CONSTRAINT "account_valid_version" CHECK(typeof("account_mutations"."version") = 'integer' AND "account_mutations"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_entity_version` ON `account_mutations` (`owner_id`,`kind`,`entity_id`,`version`);--> statement-breakpoint
CREATE TABLE `monthly_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`month` text NOT NULL,
	`category` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`active` integer NOT NULL,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "budget_exact_limit" CHECK(typeof("monthly_budgets"."amount_minor") = 'integer' AND "monthly_budgets"."amount_minor" BETWEEN 1 AND 999999999999),
	CONSTRAINT "budget_valid_month" CHECK("monthly_budgets"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND "monthly_budgets"."month" BETWEEN '1900-01' AND '9999-12' AND substr("monthly_budgets"."month", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "budget_valid_currency" CHECK("monthly_budgets"."currency" IN ('MXN', 'USD', 'EUR')),
	CONSTRAINT "budget_valid_category" CHECK("monthly_budgets"."category" IN ('food_drink', 'groceries', 'transport', 'shopping', 'entertainment', 'education', 'bills_services', 'health', 'home', 'pets', 'travel', 'other')),
	CONSTRAINT "budget_valid_version" CHECK(typeof("monthly_budgets"."version") = 'integer' AND "monthly_budgets"."version" > 0),
	CONSTRAINT "budget_valid_active" CHECK("monthly_budgets"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_owner_month_category_currency` ON `monthly_budgets` (`owner_id`,`month`,`category`,`currency`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`default_currency` text,
	`version` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "preferences_valid_currency" CHECK("user_preferences"."default_currency" IS NULL OR "user_preferences"."default_currency" IN ('MXN', 'USD', 'EUR')),
	CONSTRAINT "preferences_valid_version" CHECK(typeof("user_preferences"."version") = 'integer' AND "user_preferences"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_preferences_owner_id_unique` ON `user_preferences` (`owner_id`);--> statement-breakpoint
CREATE INDEX `expense_owner_created_id` ON `expenses` (`owner_id`,`created_at`,`id`);