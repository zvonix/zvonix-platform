CREATE TABLE "client_route_priorities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"sim_card_id" uuid,
	"gateway_id" uuid,
	"priority" integer,
	"last_routed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_route_priorities_one_route" CHECK (("client_route_priorities"."sim_card_id" is null) <> ("client_route_priorities"."gateway_id" is null)),
	CONSTRAINT "client_route_priorities_priority_range" CHECK ("client_route_priorities"."priority" is null or "client_route_priorities"."priority" between 1 and 99)
);
--> statement-breakpoint
ALTER TABLE "client_route_priorities" ADD CONSTRAINT "client_route_priorities_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_route_priorities" ADD CONSTRAINT "client_route_priorities_sim_card_id_sim_cards_id_fk" FOREIGN KEY ("sim_card_id") REFERENCES "public"."sim_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_route_priorities" ADD CONSTRAINT "client_route_priorities_gateway_id_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."gateways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_route_priorities_sim_key" ON "client_route_priorities" USING btree ("client_id","sim_card_id") WHERE "client_route_priorities"."sim_card_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "client_route_priorities_gateway_key" ON "client_route_priorities" USING btree ("client_id","gateway_id") WHERE "client_route_priorities"."gateway_id" is not null;