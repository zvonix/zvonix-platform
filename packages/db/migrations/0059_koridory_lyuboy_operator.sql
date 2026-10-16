ALTER TABLE "price_bands" ALTER COLUMN "operator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_bands" ALTER COLUMN "min_price" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_bands" ALTER COLUMN "max_price" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_bands" ADD CONSTRAINT "price_bands_has_bound" CHECK ("price_bands"."min_price" is not null or "price_bands"."max_price" is not null);