CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"blocks" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_subscribers" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_client_key" ON "message_templates" USING btree ("client_id");--> statement-breakpoint
-- Прежние «текст до» и «текст после» бота становятся шаблоном: [до, текст клиента, после] (ADR-0087).
INSERT INTO "message_templates" ("id", "client_id", "blocks")
SELECT
	gen_random_uuid(),
	"client_id",
	(CASE WHEN "text_before" IS NULL THEN '[]'::jsonb
		ELSE jsonb_build_array(jsonb_build_object('kind', 'text', 'text', "text_before", 'when', 'always')) END)
	|| jsonb_build_array(jsonb_build_object('kind', 'body', 'when', 'always'))
	|| (CASE WHEN "text_after" IS NULL THEN '[]'::jsonb
		ELSE jsonb_build_array(jsonb_build_object('kind', 'text', 'text', "text_after", 'when', 'always')) END)
FROM "bot_connections"
WHERE "text_before" IS NOT NULL OR "text_after" IS NOT NULL;
