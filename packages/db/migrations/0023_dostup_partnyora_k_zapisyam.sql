CREATE TABLE "recording_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"granted_by_user_id" uuid,
	"reason" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_grants_reason_not_empty" CHECK (length(btrim("recording_grants"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "partners" ADD COLUMN "listens_to_recordings" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recording_grants" ADD CONSTRAINT "recording_grants_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_grants" ADD CONSTRAINT "recording_grants_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recording_grants" ADD CONSTRAINT "recording_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recording_grants_lookup_idx" ON "recording_grants" USING btree ("recording_id","partner_id","expires_at");--> statement-breakpoint
CREATE INDEX "recording_grants_partner_idx" ON "recording_grants" USING btree ("partner_id");
