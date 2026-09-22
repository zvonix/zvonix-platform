CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hostname" text,
	"sip_address" text,
	"status" text DEFAULT 'provisioned' NOT NULL,
	"agent_version" text,
	"last_heartbeat_at" timestamp with time zone,
	"active_calls" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nodes_status_check" CHECK ("nodes"."status" in ('provisioned', 'installing', 'online', 'degraded', 'offline', 'decommissioned')),
	CONSTRAINT "nodes_active_calls_non_negative" CHECK ("nodes"."active_calls" >= 0)
);
--> statement-breakpoint
ALTER TABLE "machine_credentials" DROP CONSTRAINT "machine_credentials_owner_matches_kind";--> statement-breakpoint
-- Ничьи токены установки, допускавшиеся миграцией 0003, теперь невозможны: по
-- ARCHITECTURE.md администратор сначала заводит узел, а уже потом получает команду
-- установки для него. Такие строки бессмысленны — токен без узла применить некуда,
-- и рабочими ключами они никогда не были.
DELETE FROM "machine_credentials" WHERE "owner_id" IS NULL;--> statement-breakpoint
ALTER TABLE "machine_credentials" ALTER COLUMN "owner_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_name_key" ON "nodes" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_hostname_key" ON "nodes" USING btree ("hostname") WHERE "nodes"."hostname" is not null;--> statement-breakpoint
CREATE INDEX "nodes_status_idx" ON "nodes" USING btree ("status");