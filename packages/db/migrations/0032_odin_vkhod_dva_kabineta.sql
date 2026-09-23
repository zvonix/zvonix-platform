CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"answers" jsonb NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_kind_check" CHECK ("applications"."kind" in ('client', 'partner')),
	CONSTRAINT "applications_status_check" CHECK ("applications"."status" in ('submitted', 'approved', 'rejected', 'withdrawn')),
	CONSTRAINT "applications_decided_matches_status" CHECK (("applications"."status" in ('approved', 'rejected')) = ("applications"."decided_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_check";--> statement-breakpoint
DROP INDEX "clients_owner_idx";--> statement-breakpoint
DROP INDEX "partners_owner_idx";--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "applications_open_key" ON "applications" USING btree ("user_id","kind") WHERE "applications"."status" = 'submitted';--> statement-breakpoint
CREATE INDEX "applications_status_created_idx" ON "applications" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_owner_key" ON "clients" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "partners_owner_key" ON "partners" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'partner', 'client', 'support', 'member'));--> statement-breakpoint
-- ADR-0052, шаг 1 из 2: участник рынка — роль `member`, кабинеты даёт владение карточкой.
-- Прежние `client` и `partner` переводятся здесь же; из перечисления они уйдут вторым шагом,
-- следующим выпуском, когда ни одной такой строки не останется и старый код не будет запущен.
UPDATE "users" SET "role" = 'member' WHERE "role" IN ('client', 'partner');
