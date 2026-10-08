ALTER TABLE "bot_connections" ADD COLUMN "message_price" bigint;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD COLUMN "monthly_fee" bigint;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD COLUMN "fee_paid_period" text;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_prices_check" CHECK (("bot_connections"."message_price" is null or "bot_connections"."message_price" >= 0) and ("bot_connections"."monthly_fee" is null or "bot_connections"."monthly_fee" >= 0));