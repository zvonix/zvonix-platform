CREATE TABLE "client_call_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"termination_kind" text,
	"no_recording_listeners" boolean DEFAULT false NOT NULL,
	"max_price" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_call_requirements_kind_check" CHECK ("client_call_requirements"."termination_kind" is null or "client_call_requirements"."termination_kind" in ('sim', 'sip')),
	CONSTRAINT "client_call_requirements_price_check" CHECK ("client_call_requirements"."max_price" is null or "client_call_requirements"."max_price" > 0)
);
--> statement-breakpoint
ALTER TABLE "calls" DROP CONSTRAINT "calls_failure_reason_check";--> statement-breakpoint
ALTER TABLE "client_call_requirements" ADD CONSTRAINT "client_call_requirements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_call_requirements_client_key" ON "client_call_requirements" USING btree ("client_id");--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_failure_reason_check" CHECK ("calls"."failure_reason" is null or "calls"."failure_reason" in ('channel_unknown', 'destination_invalid', 'operator_unconfirmed', 'destination_blocked', 'operator_not_allowed', 'no_tariff', 'insufficient_funds', 'limit_exceeded', 'no_sim_available', 'gateway_unregistered', 'recording_required', 'no_coverage', 'requirements_unmet', 'node_lost', 'internal_error'));