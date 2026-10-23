CREATE TABLE "bot_subscriber_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_subscriber_events_kind_check" CHECK ("bot_subscriber_events"."kind" in ('started', 'restarted', 'phone_shared', 'stopped'))
);
--> statement-breakpoint
ALTER TABLE "bot_subscriber_events" ADD CONSTRAINT "bot_subscriber_events_subscriber_id_bot_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."bot_subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscriber_events" ADD CONSTRAINT "bot_subscriber_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_subscriber_events" ADD CONSTRAINT "bot_subscriber_events_bot_id_messenger_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."messenger_bots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_subscriber_events_client_idx" ON "bot_subscriber_events" USING btree ("client_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_subscriber_events_subscriber_idx" ON "bot_subscriber_events" USING btree ("subscriber_id");--> statement-breakpoint
-- Прошлое (ADR-0099): известна только дата подписки — она и становится событием «впервые запустил». Когда делились номером
-- и кто останавливал до выпуска — неизвестно, эти события начинаются с выпуска.
INSERT INTO "bot_subscriber_events" ("id", "subscriber_id", "client_id", "bot_id", "kind", "created_at")
SELECT gen_random_uuid(), "id", "client_id", "bot_id", 'started', "created_at" FROM "bot_subscribers";
