CREATE TABLE "channel_partner_priorities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"partner_id" uuid NOT NULL,
	"priority" integer NOT NULL,
	"last_routed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_partner_priorities_priority_positive" CHECK ("channel_partner_priorities"."priority" > 0)
);
--> statement-breakpoint
ALTER TABLE "channel_partner_priorities" ADD CONSTRAINT "channel_partner_priorities_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_partner_priorities" ADD CONSTRAINT "channel_partner_priorities_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_partner_priorities_channel_partner_key" ON "channel_partner_priorities" USING btree ("channel_id","partner_id");--> statement-breakpoint
CREATE INDEX "channel_partner_priorities_order_idx" ON "channel_partner_priorities" USING btree ("channel_id","priority","last_routed_at");