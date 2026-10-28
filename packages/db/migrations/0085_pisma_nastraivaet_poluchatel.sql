CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"low_balance" boolean DEFAULT true NOT NULL,
	"low_balance_threshold" bigint,
	"payment_decision" boolean DEFAULT true NOT NULL,
	"equipment_suspended" boolean DEFAULT true NOT NULL,
	"poor_connection" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_threshold_positive" CHECK ("notification_preferences"."low_balance_threshold" is null or "notification_preferences"."low_balance_threshold" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_key" ON "notification_preferences" USING btree ("user_id");