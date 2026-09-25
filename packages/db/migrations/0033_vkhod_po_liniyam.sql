ALTER TABLE "gateway_ports" ADD COLUMN "sip_username" text;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD COLUMN "a1_hash" text;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gateways" ADD COLUMN "registration_mode" text DEFAULT 'gateway' NOT NULL;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD CONSTRAINT "gateway_ports_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_ports_sip_username_key" ON "gateway_ports" USING btree ("sip_username") WHERE "gateway_ports"."sip_username" is not null;--> statement-breakpoint
ALTER TABLE "gateway_ports" ADD CONSTRAINT "gateway_ports_credentials_together" CHECK (("gateway_ports"."sip_username" is null) = ("gateway_ports"."a1_hash" is null));--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_registration_mode_check" CHECK ("gateways"."registration_mode" in ('gateway', 'port'));--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_port_registration_goip_only" CHECK ("gateways"."registration_mode" = 'gateway' or "gateways"."type" = 'goip');