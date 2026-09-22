CREATE TABLE "sip_trunks" (
	"gateway_id" uuid PRIMARY KEY NOT NULL,
	"proxy_host" text NOT NULL,
	"registers_outbound" boolean DEFAULT true NOT NULL,
	"outbound_username" text,
	"outbound_secret" text,
	"max_concurrent_calls" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sip_trunks_concurrency_range" CHECK ("sip_trunks"."max_concurrent_calls" between 1 and 1000),
	CONSTRAINT "sip_trunks_registration_needs_credentials" CHECK (not "sip_trunks"."registers_outbound" or ("sip_trunks"."outbound_username" is not null and "sip_trunks"."outbound_secret" is not null))
);
--> statement-breakpoint
ALTER TABLE "gateways" DROP CONSTRAINT "gateways_type_check";--> statement-breakpoint
ALTER TABLE "gateways" ALTER COLUMN "a1_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sip_trunks" ADD CONSTRAINT "sip_trunks_gateway_id_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_a1_hash_required" CHECK ("gateways"."a1_hash" is not null or "gateways"."type" = 'sip_trunk');--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_type_check" CHECK ("gateways"."type" in ('goip', 'android', 'sip_trunk'));