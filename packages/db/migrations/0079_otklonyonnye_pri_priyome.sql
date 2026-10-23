CREATE TABLE "message_refusals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_refusals_channel_check" CHECK ("message_refusals"."channel" in ('api', 'smpp')),
	CONSTRAINT "message_refusals_reason_check" CHECK ("message_refusals"."reason" in ('all_busy', 'no_capacity', 'recipient_not_in_max', 'recipient_inactive', 'recipient_stopped', 'duplicate_message', 'recipient_limit', 'insufficient_funds', 'requirements_unmet', 'bot_only', 'other'))
);
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_failure_reason_check";--> statement-breakpoint
ALTER TABLE "message_refusals" ADD CONSTRAINT "message_refusals_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_refusals_client_idx" ON "message_refusals" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "message_refusals_created_idx" ON "message_refusals" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_failure_reason_check" CHECK ("messages"."failure_reason" is null or "messages"."failure_reason" in ('recipient_not_in_max', 'account_unavailable', 'wait_expired', 'platform', 'recipient_stopped', 'provider_timeout'));