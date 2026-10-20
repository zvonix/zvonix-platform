DROP INDEX "message_stops_phone_key";--> statement-breakpoint
ALTER TABLE "message_stops" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "message_stops" ADD CONSTRAINT "message_stops_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_stops_global_key" ON "message_stops" USING btree ("phone") WHERE "message_stops"."client_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "message_stops_client_key" ON "message_stops" USING btree ("phone","client_id") WHERE "message_stops"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "message_stops_client_idx" ON "message_stops" USING btree ("client_id");