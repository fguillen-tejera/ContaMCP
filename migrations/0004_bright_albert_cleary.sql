CREATE TABLE `planning_mutations` (
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`details_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `idempotency_key`),
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "planning_positive_version" CHECK("planning_mutations"."version" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planning_entity_version` ON `planning_mutations` (`owner_id`,`kind`,`entity_id`,`version`);--> statement-breakpoint
CREATE TABLE `recurring_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recurring_valid_data" CHECK(json_valid("recurring_entries"."data") AND json_extract("recurring_entries"."data", '$.id') = "recurring_entries"."id" AND json_extract("recurring_entries"."data", '$.version') = "recurring_entries"."version" AND "recurring_entries"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `recurring_owner_id` ON `recurring_entries` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `savings_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "goal_valid_data" CHECK(json_valid("savings_goals"."data") AND json_extract("savings_goals"."data", '$.id') = "savings_goals"."id" AND json_extract("savings_goals"."data", '$.version') = "savings_goals"."version" AND "savings_goals"."version" > 0),
	CONSTRAINT "goal_exact_balance" CHECK(CAST(CAST(json_extract("savings_goals"."data", '$.savedMinor') AS INTEGER) AS TEXT) = json_extract("savings_goals"."data", '$.savedMinor') AND CAST(json_extract("savings_goals"."data", '$.savedMinor') AS INTEGER) BETWEEN 0 AND 999999999999)
);
--> statement-breakpoint
CREATE INDEX `goal_owner_id` ON `savings_goals` (`owner_id`,`id`);--> statement-breakpoint
ALTER TABLE `expenses` ADD `type` text DEFAULT 'expense' NOT NULL CONSTRAINT `valid_entry_type` CHECK(`type` IN ('expense', 'income'));--> statement-breakpoint
ALTER TABLE `expenses` ADD `recurring_id` text;--> statement-breakpoint
ALTER TABLE `expenses` ADD `occurrence_date` text CONSTRAINT `valid_occurrence` CHECK((`recurring_id` IS NULL AND `occurrence_date` IS NULL) OR (`recurring_id` IS NOT NULL AND `occurrence_date` IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX `entry_recurring_occurrence` ON `expenses` (`owner_id`,`recurring_id`,`occurrence_date`);--> statement-breakpoint
CREATE INDEX `entry_duplicate_lookup` ON `expenses` (`owner_id`,`type`,`currency`,`date`);--> statement-breakpoint
