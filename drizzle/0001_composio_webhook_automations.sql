ALTER TABLE `automation_jobs` ADD `composio_trigger_id` text;--> statement-breakpoint
ALTER TABLE `automation_jobs` ADD `composio_trigger_slug` text;--> statement-breakpoint
ALTER TABLE `automation_jobs` ADD `composio_toolkit_slug` text;--> statement-breakpoint
ALTER TABLE `automation_jobs` ADD `composio_connected_account_id` text;--> statement-breakpoint
ALTER TABLE `automation_jobs` ADD `composio_user_id` text;--> statement-breakpoint
ALTER TABLE `automation_jobs` ADD `webhook_trigger_config_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_automation_jobs_composio_trigger_id` ON `automation_jobs` (`composio_trigger_id`);--> statement-breakpoint
CREATE TABLE `composio_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`webhook_id` text,
	`trigger_id` text,
	`job_id` text,
	`run_id` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`metadata_json` text,
	`received_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `automation_jobs`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_composio_webhook_events_event_id` ON `composio_webhook_events` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_composio_webhook_events_webhook_id` ON `composio_webhook_events` (`webhook_id`);--> statement-breakpoint
CREATE INDEX `idx_composio_webhook_events_trigger` ON `composio_webhook_events` (`trigger_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_composio_webhook_events_job` ON `composio_webhook_events` (`job_id`,`received_at`);
