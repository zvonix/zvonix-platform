CREATE TABLE "client_account_exclusions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_message_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"stop_line" text DEFAULT 'any' NOT NULL,
	"recommended_only" boolean DEFAULT false NOT NULL,
	"max_price" bigint,
	"min_age_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_message_requirements_stop_check" CHECK ("client_message_requirements"."stop_line" in ('any', 'required', 'forbidden')),
	CONSTRAINT "client_message_requirements_age_check" CHECK ("client_message_requirements"."min_age_days" is null or "client_message_requirements"."min_age_days" between 1 and 365),
	CONSTRAINT "client_message_requirements_price_check" CHECK ("client_message_requirements"."max_price" is null or "client_message_requirements"."max_price" > 0)
);
--> statement-breakpoint
ALTER TABLE "client_account_exclusions" ADD CONSTRAINT "client_account_exclusions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_account_exclusions" ADD CONSTRAINT "client_account_exclusions_account_id_messenger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."messenger_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_message_requirements" ADD CONSTRAINT "client_message_requirements_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "client_account_exclusions_key" ON "client_account_exclusions" USING btree ("client_id","account_id");--> statement-breakpoint
CREATE INDEX "client_account_exclusions_account_idx" ON "client_account_exclusions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_message_requirements_client_key" ON "client_message_requirements" USING btree ("client_id");