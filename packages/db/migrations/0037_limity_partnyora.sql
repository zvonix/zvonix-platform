ALTER TABLE "limit_counters" DROP CONSTRAINT "limit_counters_bucket_key";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_subject_key";--> statement-breakpoint
ALTER TABLE "limit_rules" DROP CONSTRAINT "limit_rules_window_check";--> statement-breakpoint
ALTER TABLE "limit_counters" ADD COLUMN "sim_card_id" uuid;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD COLUMN "per_sim" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD COLUMN "rounding" text DEFAULT 'second' NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD COLUMN "period_start_day" smallint;--> statement-breakpoint
ALTER TABLE "limit_rules" ADD COLUMN "set_by" text DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "limit_counters" ADD CONSTRAINT "limit_counters_sim_card_id_sim_cards_id_fk" FOREIGN KEY ("sim_card_id") REFERENCES "public"."sim_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "limit_counters" ADD CONSTRAINT "limit_counters_bucket_key" UNIQUE NULLS NOT DISTINCT("limit_rule_id","sim_card_id","bucket_start");--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_subject_key" UNIQUE NULLS NOT DISTINCT("client_id","channel_id","partner_id","sim_card_id","window","metric","per_sim","set_by");--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_rounding_check" CHECK ("limit_rules"."rounding" in ('second', 'minute'));--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_set_by_check" CHECK ("limit_rules"."set_by" in ('platform', 'partner'));--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_rounding_minutes" CHECK ("limit_rules"."metric" = 'minutes' or "limit_rules"."rounding" = 'second');--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_per_sim_partner" CHECK (not "limit_rules"."per_sim" or "limit_rules"."partner_id" is not null);--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_period_start_day" CHECK ("limit_rules"."period_start_day" is null or ("limit_rules"."window" = 'month' and "limit_rules"."period_start_day" between 1 and 28));--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_partner_sets_own" CHECK ("limit_rules"."set_by" = 'platform' or "limit_rules"."partner_id" is not null or "limit_rules"."sim_card_id" is not null);--> statement-breakpoint
ALTER TABLE "limit_rules" ADD CONSTRAINT "limit_rules_window_check" CHECK ("limit_rules"."window" in ('minute', 'hour', 'day', 'week', 'month'));