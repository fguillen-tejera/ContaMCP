-- Add provenance without rebuilding the parent ledger table or changing stored audit snapshots.
ALTER TABLE `expenses` ADD `source` text DEFAULT 'user' NOT NULL CONSTRAINT `valid_recording_source` CHECK(`source` IN ('user', 'recurring'));--> statement-breakpoint
ALTER TABLE `expenses` ADD `payment_status` text DEFAULT 'confirmed' NOT NULL CONSTRAINT `valid_payment_status` CHECK(`payment_status` IN ('confirmed', 'unverified') AND (`payment_status` = 'confirmed' OR (`source` = 'recurring' AND `recurring_id` IS NOT NULL)));
