DROP INDEX "messages_receipt_idx";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "receipt_events" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD COLUMN "receipt_on_sent" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD COLUMN "receipt_on_delivered" text DEFAULT 'delivered' NOT NULL;--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD COLUMN "receipt_on_read" text DEFAULT 'delivered' NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_receipt_idx" ON "messages" USING btree ("client_id","created_at") WHERE "messages"."channel" = 'smpp';--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_receipt_on_sent_check" CHECK ("smpp_accounts"."receipt_on_sent" in ('none', 'accepted', 'delivered'));--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_receipt_on_delivered_check" CHECK ("smpp_accounts"."receipt_on_delivered" in ('none', 'accepted', 'delivered'));--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_receipt_on_read_check" CHECK ("smpp_accounts"."receipt_on_read" in ('none', 'accepted', 'delivered'));--> statement-breakpoint
-- Данные (ADR-0076): отчёты, уже принятые клиентами SMPP, повторно не отдаются — у них отмечены все события.
UPDATE "messages" SET "receipt_events" = ARRAY['sent', 'delivered', 'read', 'failed'] WHERE "receipt_sent_at" IS NOT NULL;
