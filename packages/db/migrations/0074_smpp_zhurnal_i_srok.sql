CREATE TABLE "smpp_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"result" text NOT NULL,
	"ip" text NOT NULL,
	"mode" text,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smpp_events_kind_check" CHECK ("smpp_events"."kind" in ('bind', 'submit')),
	CONSTRAINT "smpp_events_result_check" CHECK (("smpp_events"."kind" = 'bind' and "smpp_events"."result" in ('ok', 'wrong_password', 'ip_not_allowed', 'disabled', 'product_off', 'client_inactive', 'too_many_sessions', 'ip_blocked')) or ("smpp_events"."kind" = 'submit' and "smpp_events"."result" in ('invalid_destination', 'invalid_length', 'invalid_validity', 'wrong_mode', 'rejected', 'throttled', 'system_error'))),
	CONSTRAINT "smpp_events_mode_check" CHECK ("smpp_events"."mode" is null or "smpp_events"."mode" in ('transmitter', 'receiver', 'transceiver')),
	CONSTRAINT "smpp_events_count_check" CHECK ("smpp_events"."count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "client_message_requirements" ADD COLUMN "busy_mode" text;--> statement-breakpoint
ALTER TABLE "client_message_requirements" ADD COLUMN "max_wait_minutes" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "smpp_events" ADD CONSTRAINT "smpp_events_account_id_smpp_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."smpp_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "smpp_events_account_idx" ON "smpp_events" USING btree ("account_id","last_at");--> statement-breakpoint
CREATE INDEX "smpp_events_last_idx" ON "smpp_events" USING btree ("last_at");--> statement-breakpoint
ALTER TABLE "client_message_requirements" ADD CONSTRAINT "client_message_requirements_busy_check" CHECK ("client_message_requirements"."busy_mode" is null or "client_message_requirements"."busy_mode" in ('reject', 'wait'));--> statement-breakpoint
ALTER TABLE "client_message_requirements" ADD CONSTRAINT "client_message_requirements_wait_check" CHECK ("client_message_requirements"."max_wait_minutes" is null or "client_message_requirements"."max_wait_minutes" between 1 and 1440);