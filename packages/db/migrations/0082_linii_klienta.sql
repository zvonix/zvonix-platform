ALTER TABLE "channels" DROP CONSTRAINT "channels_status_check";--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "suspended_by" text;--> statement-breakpoint
-- Существующие выключенные линии выключала площадка: клиент сам выключать не мог (ADR-0101).
UPDATE "channels" SET "suspended_by" = 'admin' WHERE "status" = 'suspended';--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "comment" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "max_concurrent_calls" integer;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "registration_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "registration_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "registration_address" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "registration_node_id" uuid;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_registration_node_id_nodes_id_fk" FOREIGN KEY ("registration_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_suspended_by_check" CHECK ("channels"."suspended_by" is null or "channels"."suspended_by" in ('client', 'admin'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_suspended_by_matches_status" CHECK (("channels"."status" = 'suspended') = ("channels"."suspended_by" is not null));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_max_concurrent_calls_range" CHECK ("channels"."max_concurrent_calls" is null or "channels"."max_concurrent_calls" between 1 and 1000);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_comment_length" CHECK ("channels"."comment" is null or char_length("channels"."comment") <= 500);--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_status_check" CHECK ("channels"."status" in ('pending', 'active', 'suspended', 'closed'));