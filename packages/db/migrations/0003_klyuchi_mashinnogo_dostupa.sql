CREATE TABLE "machine_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"owner_id" text,
	"label" text NOT NULL,
	"allowed_ips" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_credentials_kind_check" CHECK ("machine_credentials"."kind" in ('node', 'client_api', 'enrollment')),
	CONSTRAINT "machine_credentials_owner_matches_kind" CHECK (("machine_credentials"."kind" = 'enrollment' and "machine_credentials"."owner_id" is null) or ("machine_credentials"."kind" <> 'enrollment' and "machine_credentials"."owner_id" is not null)),
	CONSTRAINT "machine_credentials_used_at_only_enrollment" CHECK ("machine_credentials"."used_at" is null or "machine_credentials"."kind" = 'enrollment')
);
--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_credentials_key_id_key" ON "machine_credentials" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "machine_credentials_owner_idx" ON "machine_credentials" USING btree ("kind","owner_id");