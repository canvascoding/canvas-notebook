CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ai_session_db_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`type` text,
	`attachments` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ai_session_db_id`) REFERENCES `ai_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ai_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`model` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`prompt` text NOT NULL,
	`preferred_skill` text NOT NULL,
	`workspace_context_paths_json` text NOT NULL,
	`target_output_path` text,
	`schedule_kind` text NOT NULL,
	`schedule_config_json` text NOT NULL,
	`time_zone` text NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_run_status` text,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`status` text NOT NULL,
	`trigger_type` text NOT NULL,
	`scheduled_for` integer,
	`started_at` integer,
	`finished_at` integer,
	`attempt_number` integer NOT NULL,
	`output_dir` text,
	`target_output_path` text,
	`effective_target_output_path` text,
	`log_path` text,
	`result_path` text,
	`error_message` text,
	`pi_session_id` text,
	`events_log` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `automation_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `onboarding_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`completed_at` integer NOT NULL,
	`completed_by` text,
	`method` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `page_onboarding_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`page` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pi_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pi_session_db_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`pi_session_db_id`) REFERENCES `pi_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pi_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`summary_text` text,
	`summary_updated_at` integer,
	`summary_through_timestamp` integer,
	`last_message_at` integer,
	`last_viewed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pi_usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fingerprint` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`session_title_snapshot` text,
	`assistant_timestamp` integer NOT NULL,
	`stop_reason` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`input_cost` real NOT NULL,
	`output_cost` real NOT NULL,
	`cache_read_cost` real NOT NULL,
	`cache_write_cost` real NOT NULL,
	`total_cost` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pi_usage_events_fingerprint_unique` ON `pi_usage_events` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE TABLE `studio_bulk_job_line_items` (
	`id` text PRIMARY KEY NOT NULL,
	`bulk_job_id` text NOT NULL,
	`product_id` text,
	`persona_id` text,
	`studio_preset_id` text,
	`custom_prompt` text,
	`generation_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bulk_job_id`) REFERENCES `studio_bulk_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `studio_products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`persona_id`) REFERENCES `studio_personas`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`studio_preset_id`) REFERENCES `studio_presets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`generation_id`) REFERENCES `studio_generations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_studio_bulk_job_line_items_bulk_job` ON `studio_bulk_job_line_items` (`bulk_job_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_bulk_job_line_items_status` ON `studio_bulk_job_line_items` (`status`);--> statement-breakpoint
CREATE TABLE `studio_bulk_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`studio_preset_id` text,
	`additional_prompt` text,
	`aspect_ratio` text DEFAULT '1:1' NOT NULL,
	`versions_per_product` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`total_line_items` integer NOT NULL,
	`completed_line_items` integer DEFAULT 0 NOT NULL,
	`failed_line_items` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`studio_preset_id`) REFERENCES `studio_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_studio_bulk_jobs_user` ON `studio_bulk_jobs` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_bulk_jobs_status` ON `studio_bulk_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_studio_bulk_jobs_created` ON `studio_bulk_jobs` (`created_at`);--> statement-breakpoint
CREATE TABLE `studio_generation_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`variation_index` integer NOT NULL,
	`type` text NOT NULL,
	`file_path` text NOT NULL,
	`media_url` text,
	`file_size` integer,
	`mime_type` text,
	`width` integer,
	`height` integer,
	`is_favorite` integer DEFAULT false NOT NULL,
	`pi_session_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`generation_id`) REFERENCES `studio_generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_studio_gen_outputs_generation` ON `studio_generation_outputs` (`generation_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_gen_outputs_created` ON `studio_generation_outputs` (`created_at`);--> statement-breakpoint
CREATE TABLE `studio_generation_personas` (
	`generation_id` text NOT NULL,
	`persona_id` text NOT NULL,
	PRIMARY KEY(`generation_id`, `persona_id`),
	FOREIGN KEY (`generation_id`) REFERENCES `studio_generations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`persona_id`) REFERENCES `studio_personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_gen_personas_generation` ON `studio_generation_personas` (`generation_id`);--> statement-breakpoint
CREATE INDEX `idx_gen_personas_persona` ON `studio_generation_personas` (`persona_id`);--> statement-breakpoint
CREATE TABLE `studio_generation_products` (
	`generation_id` text NOT NULL,
	`product_id` text NOT NULL,
	PRIMARY KEY(`generation_id`, `product_id`),
	FOREIGN KEY (`generation_id`) REFERENCES `studio_generations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `studio_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_gen_products_generation` ON `studio_generation_products` (`generation_id`);--> statement-breakpoint
CREATE INDEX `idx_gen_products_product` ON `studio_generation_products` (`product_id`);--> statement-breakpoint
CREATE TABLE `studio_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mode` text NOT NULL,
	`prompt` text,
	`raw_prompt` text,
	`studio_preset_id` text,
	`aspect_ratio` text DEFAULT '1:1' NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`bulk_job_id` text,
	`pi_session_id` text,
	`source_generation_id` text,
	`metadata` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`studio_preset_id`) REFERENCES `studio_presets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_studio_generations_user` ON `studio_generations` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_generations_status` ON `studio_generations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_studio_generations_created` ON `studio_generations` (`created_at`);--> statement-breakpoint
CREATE TABLE `studio_persona_images` (
	`id` text PRIMARY KEY NOT NULL,
	`persona_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer,
	`source_type` text NOT NULL,
	`source_url` text,
	`sort_order` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`persona_id`) REFERENCES `studio_personas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_studio_persona_images_persona` ON `studio_persona_images` (`persona_id`);--> statement-breakpoint
CREATE TABLE `studio_personas` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`thumbnail_path` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_studio_personas_user` ON `studio_personas` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_personas_created` ON `studio_personas` (`created_at`);--> statement-breakpoint
CREATE TABLE `studio_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`is_default` integer DEFAULT false NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`category` text,
	`blocks` text NOT NULL,
	`preview_image_path` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_studio_presets_user` ON `studio_presets` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_presets_category` ON `studio_presets` (`category`);--> statement-breakpoint
CREATE INDEX `idx_studio_presets_created` ON `studio_presets` (`created_at`);--> statement-breakpoint
CREATE TABLE `studio_product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`file_path` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`file_size` integer,
	`source_type` text NOT NULL,
	`source_url` text,
	`sort_order` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `studio_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_studio_product_images_product` ON `studio_product_images` (`product_id`);--> statement-breakpoint
CREATE TABLE `studio_products` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`thumbnail_path` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_studio_products_user` ON `studio_products` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_studio_products_created` ON `studio_products` (`created_at`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`role` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `user_hint_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`hint_key` text NOT NULL,
	`page` text NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	`dismissed_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
