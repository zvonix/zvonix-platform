ALTER TABLE "test_calls" ALTER COLUMN "sim_card_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "test_calls" ALTER COLUMN "port_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "gateways" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "sim_cards" ADD COLUMN "status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "test_calls_one_dialing_per_trunk" ON "test_calls" USING btree ("gateway_id") WHERE "test_calls"."status" = 'dialing' and "test_calls"."sim_card_id" is null;--> statement-breakpoint
CREATE INDEX "test_calls_gateway_created_idx" ON "test_calls" USING btree ("gateway_id","created_at");--> statement-breakpoint
ALTER TABLE "test_calls" ADD CONSTRAINT "test_calls_sim_and_port_together" CHECK (("test_calls"."sim_card_id" is null) = ("test_calls"."port_number" is null));