CREATE TABLE "partner_distributions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"product" text NOT NULL,
	"mode" text DEFAULT 'equal' NOT NULL,
	"reserve_percent" integer DEFAULT 0 NOT NULL,
	"quiet_from_minute" integer,
	"quiet_to_minute" integer,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"sticky_recipient" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_distributions_product_check" CHECK ("partner_distributions"."product" in ('call', 'message')),
	CONSTRAINT "partner_distributions_mode_check" CHECK ("partner_distributions"."mode" in ('equal', 'remaining', 'sequential', 'weighted', 'priority')),
	CONSTRAINT "partner_distributions_reserve_check" CHECK ("partner_distributions"."reserve_percent" between 0 and 50),
	CONSTRAINT "partner_distributions_quiet_check" CHECK (("partner_distributions"."quiet_from_minute" is null) = ("partner_distributions"."quiet_to_minute" is null)
        and ("partner_distributions"."quiet_from_minute" is null or ("partner_distributions"."quiet_from_minute" between 0 and 1439 and "partner_distributions"."quiet_to_minute" between 0 and 1439 and "partner_distributions"."quiet_from_minute" <> "partner_distributions"."quiet_to_minute")))
);
--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "distribution_weight" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "distribution_priority" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_distributions" ADD CONSTRAINT "partner_distributions_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_distributions_partner_product_idx" ON "partner_distributions" USING btree ("partner_id","product");--> statement-breakpoint
CREATE INDEX "messages_recipient_idx" ON "messages" USING btree ("client_id","recipient","created_at");--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD CONSTRAINT "messenger_accounts_distribution_check" CHECK ("messenger_accounts"."distribution_weight" between 1 and 100 and "messenger_accounts"."distribution_priority" between 1 and 100);