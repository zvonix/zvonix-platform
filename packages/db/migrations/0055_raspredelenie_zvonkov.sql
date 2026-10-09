ALTER TABLE "sim_cards" ADD COLUMN "last_routed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD COLUMN "distribution_weight" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD COLUMN "distribution_priority" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD CONSTRAINT "sim_cards_distribution_check" CHECK ("sim_cards"."distribution_weight" between 1 and 100 and "sim_cards"."distribution_priority" between 1 and 100);