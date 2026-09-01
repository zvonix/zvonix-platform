CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sip_username" text NOT NULL,
	"a1_hash" text NOT NULL,
	"recording_required" boolean DEFAULT false NOT NULL,
	"caller_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_status_check" CHECK ("channels"."status" in ('pending', 'active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "gateways" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sip_username" text NOT NULL,
	"a1_hash" text NOT NULL,
	"node_id" uuid,
	"registered_at" timestamp with time zone,
	"model" text,
	"port_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateways_type_check" CHECK ("gateways"."type" in ('goip', 'android')),
	CONSTRAINT "gateways_status_check" CHECK ("gateways"."status" in ('pending', 'active', 'suspended', 'retired')),
	CONSTRAINT "gateways_port_count_non_negative" CHECK ("gateways"."port_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_sip_username_key" ON "channels" USING btree ("sip_username");--> statement-breakpoint
CREATE INDEX "channels_client_idx" ON "channels" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "channels_status_idx" ON "channels" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "gateways_sip_username_key" ON "gateways" USING btree ("sip_username");--> statement-breakpoint
CREATE INDEX "gateways_partner_idx" ON "gateways" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "gateways_node_idx" ON "gateways" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "gateways_status_idx" ON "gateways" USING btree ("status");