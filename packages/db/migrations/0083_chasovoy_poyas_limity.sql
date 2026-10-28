ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_partner_sets_own";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_metric_check";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_set_by_check";--> statement-breakpoint
-- У существующих клиентов пояс «не выбран»: их лимиты считаются по UTC, как до ADR-0102,
-- и обновление не сдвигает ни одного окна. Москва — только у новых записей.
ALTER TABLE "clients" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "clients" ALTER COLUMN "timezone" SET DEFAULT 'Europe/Moscow';--> statement-breakpoint
ALTER TABLE "limit_rules" ADD COLUMN "timezone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
-- У существующих партнёров пояс «не выбран»: их лимиты считаются по UTC, как до ADR-0102,
-- и обновление не сдвигает ни одного окна. Москва — только у новых записей.
ALTER TABLE "partners" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "partners" ALTER COLUMN "timezone" SET DEFAULT 'Europe/Moscow';--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_owner_sets_own" CHECK ("limit_rules"."set_by" = 'platform'
        or ("limit_rules"."set_by" = 'partner' and ("limit_rules"."partner_id" is not null or "limit_rules"."sim_card_id" is not null or "limit_rules"."tariff_id" is not null))
        or ("limit_rules"."set_by" = 'client' and ("limit_rules"."client_id" is not null or "limit_rules"."channel_id" is not null)));--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_money_client" CHECK ("limit_rules"."metric" <> 'money' or "limit_rules"."client_id" is not null or "limit_rules"."channel_id" is not null);--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_metric_check" CHECK ("limit_rules"."metric" in ('calls', 'minutes', 'money'));--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_set_by_check" CHECK ("limit_rules"."set_by" in ('platform', 'partner', 'client'));