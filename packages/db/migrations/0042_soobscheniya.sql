CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"external_id" text,
	"recipient" text NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"failure_reason" text,
	"account_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"provider_message_id" text,
	"client_amount" bigint NOT NULL,
	"partner_amount" bigint NOT NULL,
	"commission_amount" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed')),
	CONSTRAINT "messages_failure_reason_check" CHECK ("messages"."failure_reason" is null or "messages"."failure_reason" in ('recipient_not_in_max', 'account_unavailable', 'wait_expired', 'platform')),
	CONSTRAINT "messages_failure_matches_status" CHECK (("messages"."status" = 'failed') = ("messages"."failure_reason" is not null)),
	CONSTRAINT "messages_amounts_check" CHECK ("messages"."partner_amount" > 0 and "messages"."commission_amount" >= 0 and "messages"."client_amount" = "messages"."partner_amount" + "messages"."commission_amount")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_messenger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."messenger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_client_external_key" ON "messages" USING btree ("client_id","external_id") WHERE "messages"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_key" ON "messages" USING btree ("account_id","provider_message_id") WHERE "messages"."provider_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_client_idx" ON "messages" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_account_sent_idx" ON "messages" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_queue_idx" ON "messages" USING btree ("next_attempt_at") WHERE "messages"."status" in ('queued', 'sending');