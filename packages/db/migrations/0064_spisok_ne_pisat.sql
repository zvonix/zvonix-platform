CREATE TABLE "message_stops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_stops_source_check" CHECK ("message_stops"."source" in ('account', 'bot'))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_failure_reason_check";--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "incoming_webhook" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_stops_phone_key" ON "message_stops" USING btree ("phone");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_failure_reason_check" CHECK ("messages"."failure_reason" is null or "messages"."failure_reason" in ('recipient_not_in_max', 'account_unavailable', 'wait_expired', 'platform', 'recipient_stopped'));