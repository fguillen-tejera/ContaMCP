-- Drizzle Kit 0.31 quotes SQLite expression indexes as column names; retain the expression here.
CREATE INDEX `recurring_automatic_due` ON `recurring_entries` (json_extract("data", '$.nextDate'), `id`)
WHERE json_extract("data", '$.active') = 1
  AND json_extract("data", '$.automatic') = 1
  AND COALESCE(json_extract("data", '$.needsReview'), 0) = 0;
