CREATE TABLE "commission_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid,
	"fixed_fee" bigint DEFAULT 0 NOT NULL,
	"percent_basis_points" bigint DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_rules_fixed_fee_non_negative" CHECK ("commission_rules"."fixed_fee" >= 0),
	CONSTRAINT "commission_rules_percent_range" CHECK ("commission_rules"."percent_basis_points" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "partner_rates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"region" text,
	"price_per_minute" bigint NOT NULL,
	"billing_increment_seconds" integer DEFAULT 1 NOT NULL,
	"minimum_duration_seconds" integer DEFAULT 0 NOT NULL,
	"connection_fee" bigint DEFAULT 0 NOT NULL,
	"rounding" text DEFAULT 'half_away_from_zero' NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_rates_rounding_check" CHECK ("partner_rates"."rounding" in ('half_away_from_zero', 'toward_zero')),
	CONSTRAINT "partner_rates_price_non_negative" CHECK ("partner_rates"."price_per_minute" >= 0),
	CONSTRAINT "partner_rates_connection_fee_non_negative" CHECK ("partner_rates"."connection_fee" >= 0),
	CONSTRAINT "partner_rates_increment_positive" CHECK ("partner_rates"."billing_increment_seconds" >= 1),
	CONSTRAINT "partner_rates_minimum_non_negative" CHECK ("partner_rates"."minimum_duration_seconds" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commission_rules_lookup_idx" ON "commission_rules" USING btree ("client_id","effective_from");--> statement-breakpoint
CREATE INDEX "partner_rates_lookup_idx" ON "partner_rates" USING btree ("partner_id","operator_id","region","effective_from");