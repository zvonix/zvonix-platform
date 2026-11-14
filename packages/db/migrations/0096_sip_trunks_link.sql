ALTER TABLE "sip_trunks" ADD COLUMN "link_state" text;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "link_status" text;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "link_reported_at" timestamp with time zone;