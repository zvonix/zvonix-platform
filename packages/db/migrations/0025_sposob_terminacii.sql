DROP INDEX "channel_partner_priorities_channel_partner_key";--> statement-breakpoint
DROP INDEX "partner_rates_lookup_idx";--> statement-breakpoint
ALTER TABLE "channel_partner_priorities" ADD COLUMN "termination_kind" text DEFAULT 'sim' NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_rates" ADD COLUMN "termination_kind" text DEFAULT 'sim' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_partner_priorities_channel_offer_key" ON "channel_partner_priorities" USING btree ("channel_id","partner_id","termination_kind");--> statement-breakpoint
CREATE INDEX "partner_rates_lookup_idx" ON "partner_rates" USING btree ("partner_id","termination_kind","operator_id","region_key","effective_from");--> statement-breakpoint
ALTER TABLE "channel_partner_priorities" ADD CONSTRAINT "channel_partner_priorities_termination_kind_check" CHECK ("channel_partner_priorities"."termination_kind" in ('sim', 'sip'));--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_termination_kind_check" CHECK ("partner_rates"."termination_kind" in ('sim', 'sip'));