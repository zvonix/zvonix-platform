CREATE TABLE "gateway_ports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gateway_id" uuid NOT NULL,
	"port_number" integer NOT NULL,
	"sim_card_id" uuid,
	"state" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_ports_state_check" CHECK ("gateway_ports"."state" in ('unknown', 'idle', 'busy', 'fault', 'disabled')),
	CONSTRAINT "gateway_ports_number_positive" CHECK ("gateway_ports"."port_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sim_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"msisdn" text NOT NULL,
	"iccid" text,
	"status" text DEFAULT 'new' NOT NULL,
	"network_scope" text DEFAULT 'own_network' NOT NULL,
	"max_concurrent_calls" integer DEFAULT 1 NOT NULL,
	"operator_confirmed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_cards_status_check" CHECK ("sim_cards"."status" in ('new', 'active', 'throttled', 'blocked', 'retired')),
	CONSTRAINT "sim_cards_network_scope_check" CHECK ("sim_cards"."network_scope" in ('own_network')),
	CONSTRAINT "sim_cards_msisdn_format" CHECK ("sim_cards"."msisdn" ~ '^7[0-9]{10}$'),
	CONSTRAINT "sim_cards_max_concurrent_calls_range" CHECK ("sim_cards"."max_concurrent_calls" between 1 and 8)
);
--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD CONSTRAINT "gateway_ports_gateway_id_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD CONSTRAINT "gateway_ports_sim_card_id_sim_cards_id_fk" FOREIGN KEY ("sim_card_id") REFERENCES "public"."sim_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD CONSTRAINT "sim_cards_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD CONSTRAINT "sim_cards_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_ports_slot_key" ON "gateway_ports" USING btree ("gateway_id","port_number");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_ports_sim_key" ON "gateway_ports" USING btree ("sim_card_id") WHERE "gateway_ports"."sim_card_id" is not null;--> statement-breakpoint
CREATE INDEX "gateway_ports_gateway_idx" ON "gateway_ports" USING btree ("gateway_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_cards_msisdn_key" ON "sim_cards" USING btree ("msisdn");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_cards_iccid_key" ON "sim_cards" USING btree ("iccid") WHERE "sim_cards"."iccid" is not null;--> statement-breakpoint
CREATE INDEX "sim_cards_partner_idx" ON "sim_cards" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "sim_cards_operator_status_idx" ON "sim_cards" USING btree ("operator_id","status");