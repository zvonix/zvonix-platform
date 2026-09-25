CREATE TABLE "test_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sim_card_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"gateway_id" uuid NOT NULL,
	"port_number" integer NOT NULL,
	"node_id" uuid,
	"destination" text NOT NULL,
	"sip_username" text NOT NULL,
	"requested_by" uuid,
	"status" text DEFAULT 'dialing' NOT NULL,
	"hangup_cause" text,
	"sip_status" text,
	"talk_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "test_calls_status_check" CHECK ("test_calls"."status" in ('dialing', 'answered', 'busy', 'no_answer', 'failed', 'unknown')),
	CONSTRAINT "test_calls_talk_seconds_non_negative" CHECK ("test_calls"."talk_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "esl_secret" text;--> statement-breakpoint
ALTER TABLE "test_calls" ADD CONSTRAINT "test_calls_sim_card_id_sim_cards_id_fk" FOREIGN KEY ("sim_card_id") REFERENCES "public"."sim_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_calls" ADD CONSTRAINT "test_calls_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_calls" ADD CONSTRAINT "test_calls_gateway_id_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_calls" ADD CONSTRAINT "test_calls_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_calls" ADD CONSTRAINT "test_calls_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "test_calls_one_dialing_per_sim" ON "test_calls" USING btree ("sim_card_id") WHERE "test_calls"."status" = 'dialing';--> statement-breakpoint
CREATE INDEX "test_calls_sim_created_idx" ON "test_calls" USING btree ("sim_card_id","created_at");