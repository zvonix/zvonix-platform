CREATE TABLE "limit_counters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"limit_rule_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_counters_bucket_key" UNIQUE("limit_rule_id","bucket_start"),
	CONSTRAINT "limit_counters_amount_non_negative" CHECK ("limit_counters"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "limit_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid,
	"channel_id" uuid,
	"partner_id" uuid,
	"sim_card_id" uuid,
	"window" text NOT NULL,
	"metric" text NOT NULL,
	"value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_rules_subject_key" UNIQUE NULLS NOT DISTINCT("client_id","channel_id","partner_id","sim_card_id","window","metric"),
	CONSTRAINT "limit_rules_window_check" CHECK ("limit_rules"."window" in ('hour', 'day', 'week', 'month')),
	CONSTRAINT "limit_rules_metric_check" CHECK ("limit_rules"."metric" in ('calls', 'minutes')),
	CONSTRAINT "limit_rules_value_positive" CHECK ("limit_rules"."value" > 0),
	CONSTRAINT "limit_rules_single_subject" CHECK (("limit_rules"."client_id" is not null)::int + ("limit_rules"."channel_id" is not null)::int + ("limit_rules"."partner_id" is not null)::int + ("limit_rules"."sim_card_id" is not null)::int = 1)
);
--> statement-breakpoint
ALTER TABLE "limit_counters" ADD CONSTRAINT "limit_counters_limit_rule_id_limit_rules_id_fk" FOREIGN KEY ("limit_rule_id") REFERENCES "public"."limit_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_sim_card_id_sim_cards_id_fk" FOREIGN KEY ("sim_card_id") REFERENCES "public"."sim_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "limit_counters_bucket_idx" ON "limit_counters" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "limit_rules_client_idx" ON "limit_rules" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "limit_rules_channel_idx" ON "limit_rules" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "limit_rules_partner_idx" ON "limit_rules" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "limit_rules_sim_idx" ON "limit_rules" USING btree ("sim_card_id");