/*
 0012 — immutable balanced journal (DECISION: DEC-010, DEC-011, DEC-013, DEC-014).
 Data backfill is performed by lib/db/migrate-to-immutable-ledger.ts because
 canonical SHA-256 payloads and deterministic UUIDs are application primitives.
*/
PRAGMA foreign_keys=ON;--> statement-breakpoint

CREATE TABLE `instruments` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `label` text NOT NULL,
  `symbol` text,
  `unit` text NOT NULL,
  `category` text,
  `price_source` text,
  `price_currency` text,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `instruments_kind_valid` CHECK(`kind` IN ('currency','security','commodity','manual')),
  CONSTRAINT `instruments_label_valid` CHECK(length(trim(`label`)) > 0),
  CONSTRAINT `instruments_unit_valid` CHECK(length(trim(`unit`)) > 0),
  CONSTRAINT `instruments_price_currency_valid` CHECK(`price_currency` IS NULL OR `price_currency` GLOB '[A-Z][A-Z][A-Z]')
);--> statement-breakpoint
CREATE INDEX `instruments_kind_symbol_idx` ON `instruments` (`kind`,`symbol`) WHERE `symbol` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `instruments_kind_idx` ON `instruments` (`kind`);--> statement-breakpoint

CREATE TABLE `instrument_observations` (
  `instrument_id` text NOT NULL REFERENCES `instruments`(`id`) ON DELETE RESTRICT,
  `observation_kind` text NOT NULL,
  `observed_day` text NOT NULL,
  `observed_at` integer NOT NULL,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `source` text,
  CONSTRAINT `instrument_observations_kind_valid` CHECK(`observation_kind` IN ('price','valuation')),
  CONSTRAINT `instrument_observations_day_valid` CHECK(`observed_day` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(`observed_day`, '+0 days') = `observed_day`),
  CONSTRAINT `instrument_observations_amount_valid` CHECK(typeof(`amount_minor`) = 'integer'),
  CONSTRAINT `instrument_observations_currency_valid` CHECK(`currency` GLOB '[A-Z][A-Z][A-Z]')
);--> statement-breakpoint
CREATE UNIQUE INDEX `instrument_observations_latest_day_unique` ON `instrument_observations` (`instrument_id`,`observation_kind`,`observed_day`);--> statement-breakpoint
CREATE INDEX `instrument_observations_observed_at_idx` ON `instrument_observations` (`observed_at`);--> statement-breakpoint

CREATE TABLE `ledger_accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `target_type` text NOT NULL,
  `target_ref` text NOT NULL,
  `currency` text NOT NULL,
  `instrument_id` text REFERENCES `instruments`(`id`) ON DELETE RESTRICT,
  `created_at` integer DEFAULT (unixepoch()) NOT NULL,
  CONSTRAINT `ledger_accounts_type_valid` CHECK(`target_type` IN ('real_account','category','instrument','system')),
  CONSTRAINT `ledger_accounts_ref_valid` CHECK(length(trim(`target_ref`)) > 0),
  CONSTRAINT `ledger_accounts_currency_valid` CHECK(`currency` GLOB '[A-Z][A-Z][A-Z]'),
  CONSTRAINT `ledger_accounts_instrument_shape` CHECK((`target_type` = 'instrument') = (`instrument_id` IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_accounts_target_unique` ON `ledger_accounts` (`target_type`,`target_ref`,`currency`);--> statement-breakpoint
CREATE INDEX `ledger_accounts_target_idx` ON `ledger_accounts` (`target_type`,`target_ref`);--> statement-breakpoint

CREATE TRIGGER `ledger_accounts_validate_insert`
BEFORE INSERT ON `ledger_accounts`
BEGIN
  SELECT CASE WHEN NEW.`target_type` = 'real_account' AND NOT EXISTS (
    SELECT 1 FROM `accounts`
    WHERE `id` = CAST(NEW.`target_ref` AS INTEGER)
      AND CAST(`id` AS TEXT) = NEW.`target_ref`
      AND `currency` = NEW.`currency`
  ) THEN RAISE(ABORT, 'real account ledger target is not registered') END;
  SELECT CASE WHEN NEW.`target_type` = 'category' AND NOT EXISTS (
    SELECT 1 FROM `categories`
    WHERE `id` = CAST(NEW.`target_ref` AS INTEGER)
      AND CAST(`id` AS TEXT) = NEW.`target_ref`
  ) THEN RAISE(ABORT, 'category ledger target is not registered') END;
END;--> statement-breakpoint

CREATE TABLE `ledger_events` (
  `event_id` text PRIMARY KEY NOT NULL,
  `sequence` integer NOT NULL,
  `payload_version` integer NOT NULL,
  `effective_date` text NOT NULL,
  `description` text NOT NULL,
  `amends_event_id` text REFERENCES `ledger_events`(`event_id`) ON DELETE RESTRICT,
  `metadata_json` text NOT NULL,
  `canonical_payload` text NOT NULL,
  `previous_hash` text,
  `hash` text NOT NULL,
  `recorded_at` integer NOT NULL,
  CONSTRAINT `ledger_events_sequence_valid` CHECK(typeof(`sequence`) = 'integer' AND `sequence` > 0),
  CONSTRAINT `ledger_events_payload_version_valid` CHECK(typeof(`payload_version`) = 'integer' AND `payload_version` = 1),
  CONSTRAINT `ledger_events_effective_date_valid` CHECK(`effective_date` GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(`effective_date`, '+0 days') = `effective_date`),
  CONSTRAINT `ledger_events_previous_hash_valid` CHECK(`previous_hash` IS NULL OR (length(`previous_hash`) = 64 AND `previous_hash` NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT `ledger_events_hash_valid` CHECK(length(`hash`) = 64 AND `hash` NOT GLOB '*[^0-9a-f]*')
);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_events_sequence_unique` ON `ledger_events` (`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_events_hash_unique` ON `ledger_events` (`hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_events_amended_once_unique` ON `ledger_events` (`amends_event_id`) WHERE `amends_event_id` IS NOT NULL;--> statement-breakpoint

CREATE TABLE `ledger_movements` (
  `event_id` text NOT NULL REFERENCES `ledger_events`(`event_id`) ON DELETE RESTRICT,
  `position` integer NOT NULL,
  `ledger_account_id` text NOT NULL REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT,
  `amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `quantity_delta` text,
  PRIMARY KEY (`event_id`,`position`),
  CONSTRAINT `ledger_movements_position_valid` CHECK(typeof(`position`) = 'integer' AND `position` >= 0),
  CONSTRAINT `ledger_movements_amount_valid` CHECK(typeof(`amount_minor`) = 'integer'),
  CONSTRAINT `ledger_movements_currency_valid` CHECK(`currency` GLOB '[A-Z][A-Z][A-Z]')
);--> statement-breakpoint
CREATE INDEX `ledger_movements_account_idx` ON `ledger_movements` (`ledger_account_id`);--> statement-breakpoint

CREATE TABLE `ledger_projection_state` (
  `projection` text PRIMARY KEY NOT NULL,
  `last_event_id` text REFERENCES `ledger_events`(`event_id`) ON DELETE RESTRICT,
  `last_event_hash` text,
  `event_count` integer DEFAULT 0 NOT NULL,
  `rebuilt_at` integer,
  `verified_at` integer
);--> statement-breakpoint

CREATE TABLE `instrument_positions` (
  `instrument_id` text NOT NULL REFERENCES `instruments`(`id`) ON DELETE RESTRICT,
  `quantity` text NOT NULL,
  `book_amount_minor` integer NOT NULL,
  `currency` text NOT NULL,
  `current_event_id` text NOT NULL REFERENCES `ledger_events`(`event_id`) ON DELETE RESTRICT,
  PRIMARY KEY (`instrument_id`,`currency`)
);--> statement-breakpoint

ALTER TABLE `transactions` ADD COLUMN `current_event_id` text REFERENCES `ledger_events`(`event_id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `transactions` ADD COLUMN `instrument_id` text REFERENCES `instruments`(`id`) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `transactions` ADD COLUMN `quantity_delta` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD COLUMN `transfer_principal_amount_cents` integer;--> statement-breakpoint
ALTER TABLE `assets` ADD COLUMN `instrument_id` text REFERENCES `instruments`(`id`) ON DELETE RESTRICT;--> statement-breakpoint

CREATE TABLE `transaction_allocations` (
  `transaction_id` integer NOT NULL REFERENCES `transactions`(`id`) ON DELETE CASCADE,
  `position` integer NOT NULL,
  `category_id` integer NOT NULL REFERENCES `categories`(`id`) ON DELETE RESTRICT,
  `amount_cents` integer NOT NULL,
  PRIMARY KEY (`transaction_id`,`position`),
  CONSTRAINT `transaction_allocations_amount_valid` CHECK(typeof(`amount_cents`) = 'integer' AND `amount_cents` > 0)
);--> statement-breakpoint

CREATE TRIGGER `ledger_events_validate_insert`
BEFORE INSERT ON `ledger_events`
BEGIN
  SELECT CASE WHEN length(NEW.`event_id`) <> 36
    OR substr(NEW.`event_id`,9,1) <> '-' OR substr(NEW.`event_id`,14,1) <> '-'
    OR substr(NEW.`event_id`,19,1) <> '-' OR substr(NEW.`event_id`,24,1) <> '-'
    OR length(replace(NEW.`event_id`, '-', '')) <> 32
    OR lower(replace(NEW.`event_id`, '-', '')) GLOB '*[^0-9a-f]*'
    OR lower(substr(NEW.`event_id`,15,1)) NOT GLOB '[1-8]'
    OR lower(substr(NEW.`event_id`,20,1)) NOT GLOB '[89ab]'
    THEN RAISE(ABORT, 'ledger event id must be a UUID') END;
  SELECT CASE WHEN NEW.`sequence` <> COALESCE((SELECT MAX(`sequence`) + 1 FROM `ledger_events`), 1)
    THEN RAISE(ABORT, 'stale ledger head sequence') END;
  SELECT CASE WHEN NEW.`previous_hash` IS NOT (SELECT `hash` FROM `ledger_events` ORDER BY `sequence` DESC LIMIT 1)
    THEN RAISE(ABORT, 'stale ledger previous hash') END;
  SELECT CASE WHEN NEW.`amends_event_id` IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM `ledger_events` WHERE `event_id` = NEW.`amends_event_id`
  ) THEN RAISE(ABORT, 'amended ledger event does not exist') END;
  SELECT CASE WHEN json_valid(NEW.`canonical_payload`) <> 1 OR json_valid(NEW.`metadata_json`) <> 1
    THEN RAISE(ABORT, 'invalid canonical ledger JSON') END;
  SELECT CASE WHEN ledger_canonical_json(NEW.`canonical_payload`) <> NEW.`canonical_payload`
    OR ledger_canonical_json(NEW.`metadata_json`) <> NEW.`metadata_json`
    THEN RAISE(ABORT, 'ledger JSON is not canonical') END;
  SELECT CASE WHEN json_type(NEW.`canonical_payload`, '$.version') IS NOT 'integer'
    OR json_type(NEW.`canonical_payload`, '$.eventId') IS NOT 'text'
    OR json_type(NEW.`canonical_payload`, '$.effectiveDate') IS NOT 'text'
    OR json_type(NEW.`canonical_payload`, '$.description') IS NOT 'text'
    OR COALESCE(json_type(NEW.`canonical_payload`, '$.amendsEventId'), 'missing') NOT IN ('null', 'text')
    OR json_type(NEW.`canonical_payload`, '$.metadata') IS NOT 'object'
    OR json_type(NEW.`canonical_payload`, '$.movements') IS NOT 'array'
    OR COALESCE(json_type(NEW.`canonical_payload`, '$.previousHash'), 'missing') NOT IN ('null', 'text')
    OR json_type(NEW.`canonical_payload`, '$.recordedAt') IS NOT 'integer'
    THEN RAISE(ABORT, 'ledger canonical payload shape is invalid') END;
  SELECT CASE WHEN NEW.`hash` <> ledger_sha256(NEW.`canonical_payload`)
    THEN RAISE(ABORT, 'ledger hash mismatch') END;
  SELECT CASE WHEN json_extract(NEW.`canonical_payload`, '$.version') <> NEW.`payload_version`
    OR json_extract(NEW.`canonical_payload`, '$.eventId') <> NEW.`event_id`
    OR json_extract(NEW.`canonical_payload`, '$.effectiveDate') <> NEW.`effective_date`
    OR json_extract(NEW.`canonical_payload`, '$.description') <> NEW.`description`
    OR json_extract(NEW.`canonical_payload`, '$.amendsEventId') IS NOT NEW.`amends_event_id`
    OR json(json_extract(NEW.`canonical_payload`, '$.metadata')) <> json(NEW.`metadata_json`)
    OR json_extract(NEW.`canonical_payload`, '$.previousHash') IS NOT NEW.`previous_hash`
    OR json_extract(NEW.`canonical_payload`, '$.recordedAt') <> NEW.`recorded_at`
    THEN RAISE(ABORT, 'ledger payload/header mismatch') END;
  SELECT CASE WHEN json_array_length(NEW.`canonical_payload`, '$.movements') < 2
    THEN RAISE(ABORT, 'ledger event requires at least two movements') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.`canonical_payload`, '$.movements') movement
    GROUP BY json_extract(movement.value, '$.currency')
    HAVING SUM(json_extract(movement.value, '$.amountMinor')) <> 0
  ) THEN RAISE(ABORT, 'ledger event is not balanced by currency') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.`canonical_payload`, '$.movements') movement
    LEFT JOIN `ledger_accounts` account
      ON account.`id` = json_extract(movement.value, '$.ledgerAccountId')
     AND account.`currency` = json_extract(movement.value, '$.currency')
    WHERE json_type(movement.value, '$.position') <> 'integer'
       OR json_extract(movement.value, '$.position') <> CAST(movement.key AS INTEGER)
       OR json_type(movement.value, '$.ledgerAccountId') <> 'text'
       OR json_type(movement.value, '$.amountMinor') <> 'integer'
       OR json_type(movement.value, '$.currency') <> 'text'
       OR json_extract(movement.value, '$.currency') NOT GLOB '[A-Z][A-Z][A-Z]'
       OR json_type(movement.value, '$.quantityDelta') NOT IN ('null', 'text')
       OR account.`id` IS NULL
       OR (json_extract(movement.value, '$.quantityDelta') IS NOT NULL AND account.`target_type` <> 'instrument')
       OR (json_extract(movement.value, '$.quantityDelta') IS NOT NULL AND (
         ledger_canonical_decimal(json_extract(movement.value, '$.quantityDelta'))
           <> json_extract(movement.value, '$.quantityDelta')
         OR json_extract(movement.value, '$.quantityDelta') = '0'
       ))
  ) THEN RAISE(ABORT, 'invalid registered ledger movement') END;
END;--> statement-breakpoint

CREATE TRIGGER `ledger_movements_validate_insert`
BEFORE INSERT ON `ledger_movements`
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM `ledger_events` event
    JOIN json_each(event.`canonical_payload`, '$.movements') movement
    WHERE event.`event_id` = NEW.`event_id`
      AND CAST(movement.key AS INTEGER) = NEW.`position`
      AND json_extract(movement.value, '$.position') IS NEW.`position`
      AND json_extract(movement.value, '$.ledgerAccountId') IS NEW.`ledger_account_id`
      AND json_extract(movement.value, '$.amountMinor') IS NEW.`amount_minor`
      AND json_extract(movement.value, '$.currency') IS NEW.`currency`
      AND json_extract(movement.value, '$.quantityDelta') IS NEW.`quantity_delta`
  ) THEN RAISE(ABORT, 'ledger movement must match its sealed canonical event') END;
END;--> statement-breakpoint

CREATE TRIGGER `ledger_events_seal_movements`
AFTER INSERT ON `ledger_events`
BEGIN
  INSERT INTO `ledger_movements` (`event_id`,`position`,`ledger_account_id`,`amount_minor`,`currency`,`quantity_delta`)
    SELECT
      NEW.`event_id`,
      CAST(movement.key AS INTEGER),
      json_extract(movement.value, '$.ledgerAccountId'),
      json_extract(movement.value, '$.amountMinor'),
      json_extract(movement.value, '$.currency'),
      json_extract(movement.value, '$.quantityDelta')
    FROM json_each(NEW.`canonical_payload`, '$.movements') movement
    ORDER BY CAST(movement.key AS INTEGER);
END;--> statement-breakpoint

CREATE TRIGGER `ledger_events_immutable_update` BEFORE UPDATE ON `ledger_events`
BEGIN SELECT RAISE(ABORT, 'ledger events are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `ledger_events_immutable_delete` BEFORE DELETE ON `ledger_events`
BEGIN SELECT RAISE(ABORT, 'ledger events are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `ledger_movements_immutable_update` BEFORE UPDATE ON `ledger_movements`
BEGIN SELECT RAISE(ABORT, 'ledger movements are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `ledger_movements_immutable_delete` BEFORE DELETE ON `ledger_movements`
BEGIN SELECT RAISE(ABORT, 'ledger movements are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `ledger_accounts_protect_update` BEFORE UPDATE ON `ledger_accounts`
WHEN EXISTS (SELECT 1 FROM `ledger_movements` WHERE `ledger_account_id` = OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'posted ledger targets are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `ledger_accounts_protect_delete` BEFORE DELETE ON `ledger_accounts`
WHEN EXISTS (SELECT 1 FROM `ledger_movements` WHERE `ledger_account_id` = OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'posted ledger targets are immutable'); END;--> statement-breakpoint
CREATE TRIGGER `instruments_protect_ledger_update`
BEFORE UPDATE OF `kind`, `symbol`, `unit` ON `instruments`
WHEN EXISTS (SELECT 1 FROM `ledger_accounts` WHERE `instrument_id` = OLD.`id`)
BEGIN SELECT RAISE(ABORT, 'posted instrument identity is immutable'); END;
