ALTER TABLE "sip_trunks" ADD COLUMN "link_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "auth_blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD COLUMN "auth_resumed_at" timestamp with time zone;