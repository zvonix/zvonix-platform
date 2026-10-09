ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_subject_key";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_per_sim_partner";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_partner_sets_own";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_single_subject";--> statement-breakpoint
ALTER TABLE "limit_rules" ADD COLUMN "tariff_id" uuid;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_tariff_id_partner_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."partner_tariffs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "limit_rules_tariff_idx" ON "limit_rules" USING btree ("tariff_id");--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_subject_key" UNIQUE NULLS NOT DISTINCT("client_id","channel_id","partner_id","sim_card_id","tariff_id","window","metric","per_sim","set_by");--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_per_sim_owner" CHECK (not "limit_rules"."per_sim" or "limit_rules"."partner_id" is not null or "limit_rules"."tariff_id" is not null);--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_tariff_per_sim" CHECK ("limit_rules"."tariff_id" is null or "limit_rules"."per_sim");--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_partner_sets_own" CHECK ("limit_rules"."set_by" = 'platform' or "limit_rules"."partner_id" is not null or "limit_rules"."sim_card_id" is not null or "limit_rules"."tariff_id" is not null);--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_single_subject" CHECK (("limit_rules"."client_id" is not null)::int + ("limit_rules"."channel_id" is not null)::int + ("limit_rules"."partner_id" is not null)::int + ("limit_rules"."sim_card_id" is not null)::int + ("limit_rules"."tariff_id" is not null)::int = 1);