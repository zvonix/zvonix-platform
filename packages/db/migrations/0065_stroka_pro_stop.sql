ALTER TABLE "messages" ADD COLUMN "stop_line" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "stop_line" boolean DEFAULT true NOT NULL;