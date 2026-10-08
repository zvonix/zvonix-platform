ALTER TABLE "bot_connections" ADD COLUMN "greeting" text;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD COLUMN "text_before" text;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD COLUMN "text_after" text;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD COLUMN "fallback_accounts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_texts_check" CHECK (("bot_connections"."greeting" is null or char_length("bot_connections"."greeting") <= 300)
        and ("bot_connections"."text_before" is null or char_length("bot_connections"."text_before") <= 150)
        and ("bot_connections"."text_after" is null or char_length("bot_connections"."text_after") <= 150));