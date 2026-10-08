CREATE TABLE "bot_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_subscribers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"max_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"phone" text,
	"state" text DEFAULT 'started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_subscribers_state_check" CHECK ("bot_subscribers"."state" in ('started', 'stopped'))
);
--> statement-breakpoint
CREATE TABLE "messenger_bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"client_id" uuid,
	"token" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_bots_kind_check" CHECK ("messenger_bots"."kind" in ('platform', 'client')),
	CONSTRAINT "messenger_bots_status_check" CHECK ("messenger_bots"."status" in ('active', 'disabled')),
	CONSTRAINT "messenger_bots_owner_check" CHECK (("messenger_bots"."kind" = 'client') = ("messenger_bots"."client_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_connections" ADD CONSTRAINT "bot_connections_bot_id_messenger_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."messenger_bots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscribers" ADD CONSTRAINT "bot_subscribers_bot_id_messenger_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."messenger_bots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscribers" ADD CONSTRAINT "bot_subscribers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messenger_bots" ADD CONSTRAINT "messenger_bots_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_connections_client_key" ON "bot_connections" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_connections_code_key" ON "bot_connections" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_subscribers_user_key" ON "bot_subscribers" USING btree ("bot_id","client_id","max_user_id");--> statement-breakpoint
CREATE INDEX "bot_subscribers_phone_idx" ON "bot_subscribers" USING btree ("client_id","phone") WHERE "bot_subscribers"."phone" is not null and "bot_subscribers"."state" = 'started';--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_bots_platform_key" ON "messenger_bots" USING btree ("kind") WHERE "messenger_bots"."kind" = 'platform';--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_bots_client_key" ON "messenger_bots" USING btree ("client_id") WHERE "messenger_bots"."client_id" is not null;