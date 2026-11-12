CREATE TABLE `agent_directory` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channel_connection` (
	`id` text PRIMARY KEY,
	`agent_id` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`status` text NOT NULL,
	`config` text NOT NULL,
	`pairing` text
);
--> statement-breakpoint
CREATE TABLE `computer` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text UNIQUE,
	`state` text NOT NULL,
	`confirmation_expires_at` integer NOT NULL,
	`credential_hash` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `computer_registration` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_sessions` (
	`token_hash` text PRIMARY KEY,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_connection_agent` ON `channel_connection` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_connection_active_account` ON `channel_connection` (`platform`,`account_id`) WHERE "channel_connection"."status" != 'disconnected';