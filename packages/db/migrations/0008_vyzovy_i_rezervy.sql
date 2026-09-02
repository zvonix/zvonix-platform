CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"channel_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"destination" text NOT NULL,
	"operator_id" uuid,
	"region" text,
	"sim_card_id" uuid,
	"gateway_id" uuid,
	"status" text DEFAULT 'routing' NOT NULL,
	"failure_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_status_check" CHECK ("calls"."status" in ('routing', 'ringing', 'answered', 'completed', 'failed', 'no_answer', 'busy', 'cancelled')),
	CONSTRAINT "calls_failure_reason_check" CHECK ("calls"."failure_reason" is null or "calls"."failure_reason" in ('channel_unknown', 'operator_unconfirmed', 'destination_blocked', 'no_tariff', 'insufficient_funds', 'limit_exceeded', 'no_sim_available', 'recording_required', 'no_coverage', 'internal_error')),
	CONSTRAINT "calls_failure_reason_matches_status" CHECK ("calls"."failure_reason" is null or "calls"."status" = 'failed'),
	CONSTRAINT "calls_duration_non_negative" CHECK ("calls"."duration_seconds" is null or "calls"."duration_seconds" >= 0),
	CONSTRAINT "calls_destination_format" CHECK ("calls"."destination" ~ '^7[0-9]{10}$')
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" in ('held', 'captured', 'released')),
	CONSTRAINT "reservations_amount_positive" CHECK ("reservations"."amount" > 0),
	CONSTRAINT "reservations_settled_at_matches_status" CHECK (("reservations"."status" = 'held' and "reservations"."settled_at" is null) or ("reservations"."status" <> 'held' and "reservations"."settled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_sim_card_id_sim_cards_id_fk" FOREIGN KEY ("sim_card_id") REFERENCES "public"."sim_cards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_gateway_id_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calls_external_id_key" ON "calls" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "calls_sim_status_idx" ON "calls" USING btree ("sim_card_id","status");--> statement-breakpoint
CREATE INDEX "calls_channel_started_idx" ON "calls" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_status_started_idx" ON "calls" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_call_key" ON "reservations" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "reservations_client_status_idx" ON "reservations" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "reservations" USING btree ("expires_at") WHERE "reservations"."status" = 'held';