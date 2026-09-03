CREATE TABLE "channel_allowed_operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" DROP CONSTRAINT "calls_failure_reason_check";--> statement-breakpoint
ALTER TABLE "channel_allowed_operators" ADD CONSTRAINT "channel_allowed_operators_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_allowed_operators" ADD CONSTRAINT "channel_allowed_operators_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_allowed_operators_key" ON "channel_allowed_operators" USING btree ("channel_id","operator_id");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_failure_reason_check" CHECK ("calls"."failure_reason" is null or "calls"."failure_reason" in ('channel_unknown', 'operator_unconfirmed', 'destination_blocked', 'operator_not_allowed', 'no_tariff', 'insufficient_funds', 'limit_exceeded', 'no_sim_available', 'recording_required', 'no_coverage', 'node_lost', 'internal_error'));