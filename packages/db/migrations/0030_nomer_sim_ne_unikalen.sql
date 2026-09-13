DROP INDEX "sim_cards_msisdn_key";--> statement-breakpoint
CREATE INDEX "sim_cards_msisdn_idx" ON "sim_cards" USING btree ("msisdn");