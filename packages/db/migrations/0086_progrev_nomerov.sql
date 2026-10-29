ALTER TABLE "sim_cards" ADD COLUMN "warmup_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "numbers_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "warmup_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "calls_sim_started_idx" ON "calls" USING btree ("sim_card_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_gateway_started_idx" ON "calls" USING btree ("gateway_id","started_at");--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD CONSTRAINT "sip_trunks_numbers_range" CHECK ("sip_trunks"."numbers_count" between 1 and 1000);