CREATE TABLE "smpp_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"system_id" text NOT NULL,
	"password_hash" text NOT NULL,
	"allowed_ips" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_bind_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "receipt_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "smpp_accounts_client_key" ON "smpp_accounts" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "smpp_accounts_system_id_key" ON "smpp_accounts" USING btree ("system_id");--> statement-breakpoint
CREATE INDEX "messages_receipt_idx" ON "messages" USING btree ("client_id","created_at") WHERE "messages"."channel" = 'smpp' and "messages"."receipt_sent_at" is null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_check" CHECK ("messages"."channel" in ('api', 'smpp'));