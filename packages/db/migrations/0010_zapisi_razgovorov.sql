CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"call_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"duration_seconds" integer,
	"size_bytes" bigint,
	"uploaded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_duration_non_negative" CHECK ("recordings"."duration_seconds" is null or "recordings"."duration_seconds" >= 0),
	CONSTRAINT "recordings_size_positive" CHECK ("recordings"."size_bytes" is null or "recordings"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_call_key" ON "recordings" USING btree ("call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recordings_object_key" ON "recordings" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "recordings_expiry_idx" ON "recordings" USING btree ("expires_at") WHERE "recordings"."deleted_at" is null;