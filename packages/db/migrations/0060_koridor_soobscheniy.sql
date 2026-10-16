DROP INDEX "price_bands_lookup_idx";--> statement-breakpoint
ALTER TABLE "price_bands" ADD COLUMN "product" text DEFAULT 'call' NOT NULL;--> statement-breakpoint
CREATE INDEX "price_bands_lookup_idx" ON "price_bands" USING btree ("product","operator_id","region_key","effective_from");--> statement-breakpoint
ALTER TABLE "price_bands" ADD CONSTRAINT "price_bands_product_check" CHECK ("price_bands"."product" in ('call', 'message'));--> statement-breakpoint
ALTER TABLE "price_bands" ADD CONSTRAINT "price_bands_message_scope" CHECK ("price_bands"."product" <> 'message' or ("price_bands"."operator_id" is null and "price_bands"."region" is null));