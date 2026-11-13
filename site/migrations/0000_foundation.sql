CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`status` text DEFAULT 'active' NOT NULL,
	`preferences` text DEFAULT '{}' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "accounts_kind_valid" CHECK("accounts"."kind" IN ('human', 'agent')),
	CONSTRAINT "accounts_role_valid" CHECK("accounts"."role" IN ('contributor', 'editor', 'administrator', 'owner')),
	CONSTRAINT "accounts_status_valid" CHECK("accounts"."status" IN ('active', 'disabled')),
	CONSTRAINT "accounts_preferences_json" CHECK(json_valid("accounts"."preferences") AND json_type("accounts"."preferences") = 'object'),
	CONSTRAINT "accounts_version_positive" CHECK("accounts"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`account_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`operation_id` text,
	`summary` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_events_summary_json" CHECK(json_valid("audit_events"."summary"))
);
--> statement-breakpoint
CREATE INDEX `audit_events_at` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_target` ON `audit_events` (`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`manifest` text NOT NULL,
	`verified_at` text,
	`verify_result` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "checkpoints_sha256_format" CHECK(length("checkpoints"."sha256") = 64 AND "checkpoints"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "checkpoints_manifest_json" CHECK(json_valid("checkpoints"."manifest")),
	CONSTRAINT "checkpoints_verify_result_valid" CHECK("checkpoints"."verify_result" IS NULL OR "checkpoints"."verify_result" IN ('passed', 'failed')),
	CONSTRAINT "checkpoints_version_positive" CHECK("checkpoints"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `counties` (
	`fips` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	CONSTRAINT "counties_fips_format" CHECK(length("counties"."fips") = 5 AND "counties"."fips" GLOB '08[0-9][0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `counties_name_unique` ON `counties` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `counties_slug_unique` ON `counties` (`slug`);--> statement-breakpoint
CREATE TABLE `identities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject` text NOT NULL,
	`label` text,
	`expires_at` text,
	`revoked_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "identities_provider_valid" CHECK("identities"."provider" IN ('sites', 'agent_key')),
	CONSTRAINT "identities_version_positive" CHECK("identities"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `identities_provider_subject_unique` ON `identities` (`provider`,`subject`);--> statement-breakpoint
CREATE INDEX `identities_account` ON `identities` (`account_id`);--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`requested_by` text,
	`params` text DEFAULT '{}' NOT NULL,
	`result` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`requested_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "operations_state_valid" CHECK("operations"."state" IN ('pending', 'running', 'succeeded', 'failed')),
	CONSTRAINT "operations_params_json" CHECK(json_valid("operations"."params")),
	CONSTRAINT "operations_result_json" CHECK("operations"."result" IS NULL OR json_valid("operations"."result")),
	CONSTRAINT "operations_progress_range" CHECK("operations"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "operations_version_positive" CHECK("operations"."version" >= 1)
);
