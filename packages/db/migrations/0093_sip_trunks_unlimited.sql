ALTER TABLE "sip_trunks" ADD COLUMN "unlimited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "unlimited_requested_at" timestamp with time zone;