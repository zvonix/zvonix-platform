CREATE TABLE "partner_tariffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_tariffs_name_length" CHECK (char_length("partner_tariffs"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "partner_rates" ALTER COLUMN "operator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "partner_rate_id" uuid;--> statement-breakpoint
ALTER TABLE "gateways" ADD COLUMN "tariff_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD COLUMN "tariff_id" uuid;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD COLUMN "tariff_id" uuid;--> statement-breakpoint
ALTER TABLE "partner_tariffs" ADD CONSTRAINT "partner_tariffs_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_tariffs_partner_name_idx" ON "partner_tariffs" USING btree ("partner_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "partner_tariffs_default_idx" ON "partner_tariffs" USING btree ("partner_id") WHERE "partner_tariffs"."is_default";--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_partner_rate_id_partner_rates_id_fk" FOREIGN KEY ("partner_rate_id") REFERENCES "public"."partner_rates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_tariff_id_partner_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."partner_tariffs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_tariff_id_partner_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."partner_tariffs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD CONSTRAINT "sim_cards_tariff_id_partner_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."partner_tariffs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_rates_tariff_lookup_idx" ON "partner_rates" USING btree ("tariff_id","termination_kind","operator_id","region_key","effective_from");--> statement-breakpoint
-- ADR-0056: у каждого партнёра — тариф «Основной», он же по умолчанию; нынешние цены
-- переезжают в него. Идентификатор порождается здесь: соглашение «uuid без DEFAULT»
-- касается колонки, а не разового переноса.
INSERT INTO "partner_tariffs" ("id", "partner_id", "name", "is_default")
SELECT gen_random_uuid(), p."id", 'Основной', true
  FROM "partners" p
 WHERE NOT EXISTS (SELECT 1 FROM "partner_tariffs" t WHERE t."partner_id" = p."id" AND t."is_default");--> statement-breakpoint
UPDATE "partner_rates" r
   SET "tariff_id" = t."id"
  FROM "partner_tariffs" t
 WHERE r."tariff_id" IS NULL
   AND t."partner_id" = r."partner_id"
   AND t."is_default";
