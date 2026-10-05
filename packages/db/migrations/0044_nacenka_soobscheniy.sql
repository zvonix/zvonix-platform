ALTER TABLE "commission_rules" DROP CONSTRAINT "commission_rules_percent_range";--> statement-breakpoint
DROP INDEX "commission_rules_lookup_idx";--> statement-breakpoint
ALTER TABLE "commission_rules" ADD COLUMN "product" text DEFAULT 'call' NOT NULL;--> statement-breakpoint
CREATE INDEX "commission_rules_lookup_idx" ON "commission_rules" USING btree ("product","client_id","effective_from");--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_product_check" CHECK ("commission_rules"."product" in ('call', 'message'));--> statement-breakpoint
ALTER TABLE "commission_rules" ADD CONSTRAINT "commission_rules_percent_range" CHECK ("commission_rules"."percent_basis_points" >= 0 and "commission_rules"."percent_basis_points" <= case when "commission_rules"."product" = 'message' then 100000 else 10000 end);;--> statement-breakpoint
-- Общее правило наценки на сообщения: берёт прежнюю настройку владельца (или 20 %), фикс 0.
INSERT INTO "commission_rules" ("id", "client_id", "product", "fixed_fee", "percent_basis_points", "effective_from")
SELECT gen_random_uuid(), NULL, 'message', 0,
  COALESCE(
    (SELECT round(value::numeric * 100)::bigint FROM "platform_settings"
      WHERE key = 'messages.markup_percent' AND value ~ '^[0-9]+(\.[0-9]+)?$' AND value::numeric <= 1000),
    2000),
  timestamptz '2000-01-01 00:00:00+00';--> statement-breakpoint
DELETE FROM "platform_settings" WHERE key = 'messages.markup_percent';
