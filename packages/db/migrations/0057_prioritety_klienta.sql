CREATE TABLE "client_partner_priorities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"offer" text NOT NULL,
	"priority" integer,
	"last_routed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_partner_priorities_offer_check" CHECK ("client_partner_priorities"."offer" in ('sim', 'sip', 'message')),
	CONSTRAINT "client_partner_priorities_priority_range" CHECK ("client_partner_priorities"."priority" is null or "client_partner_priorities"."priority" between 1 and 99)
);
--> statement-breakpoint
ALTER TABLE "client_partner_priorities" ADD CONSTRAINT "client_partner_priorities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_partner_priorities" ADD CONSTRAINT "client_partner_priorities_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_partner_priorities_key" ON "client_partner_priorities" USING btree ("client_id","partner_id","offer");