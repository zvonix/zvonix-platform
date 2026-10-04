CREATE TABLE "messenger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"label" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"provider_token" text NOT NULL,
	"provider_api_url" text NOT NULL,
	"phone" text,
	"state_checked_at" timestamp with time zone,
	"price" bigint,
	"limit_per_minute" integer,
	"limit_per_day" integer,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_accounts_status_check" CHECK ("messenger_accounts"."status" in ('pending', 'active', 'unavailable', 'retired')),
	CONSTRAINT "messenger_accounts_provider_check" CHECK ("messenger_accounts"."provider" in ('green_api', 'simulated')),
	CONSTRAINT "messenger_accounts_price_positive" CHECK ("messenger_accounts"."price" is null or "messenger_accounts"."price" > 0),
	CONSTRAINT "messenger_accounts_limits_positive" CHECK (("messenger_accounts"."limit_per_minute" is null or "messenger_accounts"."limit_per_minute" > 0) and ("messenger_accounts"."limit_per_day" is null or "messenger_accounts"."limit_per_day" > 0))
);
--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD CONSTRAINT "messenger_accounts_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_accounts_instance_key" ON "messenger_accounts" USING btree ("provider","provider_instance_id");--> statement-breakpoint
CREATE INDEX "messenger_accounts_partner_idx" ON "messenger_accounts" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "messenger_accounts_live_idx" ON "messenger_accounts" USING btree ("status") WHERE "messenger_accounts"."status" <> 'retired';