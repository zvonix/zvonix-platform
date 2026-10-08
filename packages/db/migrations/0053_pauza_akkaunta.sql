ALTER TABLE "messenger_accounts" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "health_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD CONSTRAINT "messenger_accounts_pause_reason_check" CHECK ("messenger_accounts"."pause_reason" is null or "messenger_accounts"."pause_reason" in ('absent_rate'));