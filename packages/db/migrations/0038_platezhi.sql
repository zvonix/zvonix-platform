CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount" bigint NOT NULL,
	"received_amount" bigint,
	"external_id" text,
	"comment" text,
	"resolution_note" text,
	"created_by_user_id" uuid,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" in ('pending', 'succeeded', 'rejected', 'cancelled')),
	CONSTRAINT "payments_provider_check" CHECK ("payments"."provider" in ('manual')),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount" > 0),
	CONSTRAINT "payments_received_positive" CHECK ("payments"."received_amount" is null or "payments"."received_amount" > 0),
	CONSTRAINT "payments_received_matches_status" CHECK (("payments"."status" = 'succeeded') = ("payments"."received_amount" is not null))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_external_key" ON "payments" USING btree ("provider","external_id") WHERE "payments"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_client_idx" ON "payments" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_pending_idx" ON "payments" USING btree ("created_at") WHERE "payments"."status" = 'pending';