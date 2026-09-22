CREATE TABLE "partner_coverage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"region" text NOT NULL,
	"region_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_coverage_key_not_empty" CHECK (length("partner_coverage"."region_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "partner_coverage" ADD CONSTRAINT "partner_coverage_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_coverage_partner_region_key" ON "partner_coverage" USING btree ("partner_id","region_key");