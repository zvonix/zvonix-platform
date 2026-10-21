CREATE TABLE "support_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"uploader_user_id" uuid,
	"message_id" uuid,
	"stored_name" text NOT NULL,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_attachments_type_check" CHECK ("support_attachments"."content_type" in ('png', 'jpeg', 'webp'))
);
--> statement-breakpoint
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_uploader_user_id_users_id_fk" FOREIGN KEY ("uploader_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_support_ticket_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."support_ticket_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_attachments_message_idx" ON "support_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "support_attachments_uploader_idx" ON "support_attachments" USING btree ("uploader_user_id","created_at");