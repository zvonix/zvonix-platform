CREATE TABLE "messenger_account_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_account_events_kind_check" CHECK ("messenger_account_events"."kind" in ('unavailable', 'active', 'health_paused')),
	CONSTRAINT "messenger_account_events_reason_check" CHECK ("messenger_account_events"."reason" is null or "messenger_account_events"."reason" in ('suspended', 'blocked', 'logged_out'))
);
--> statement-breakpoint
CREATE TABLE "number_checks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"result" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_checks_result_check" CHECK ("number_checks"."result" in ('exists', 'absent', 'unknown', 'limited'))
);
--> statement-breakpoint
ALTER TABLE "messenger_account_events" ADD CONSTRAINT "messenger_account_events_account_id_messenger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."messenger_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_checks" ADD CONSTRAINT "number_checks_account_id_messenger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."messenger_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messenger_account_events_account_idx" ON "messenger_account_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "messenger_account_events_created_idx" ON "messenger_account_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "number_checks_account_idx" ON "number_checks" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "number_checks_created_idx" ON "number_checks" USING btree ("created_at");