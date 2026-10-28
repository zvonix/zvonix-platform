ALTER TABLE "gateway_ports" ADD COLUMN "registration_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD COLUMN "registration_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD COLUMN "registration_address" text;--> statement-breakpoint
ALTER TABLE "gateways" ADD COLUMN "registration_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateways" ADD COLUMN "registration_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateways" ADD COLUMN "registration_address" text;