CREATE TABLE "price_bands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"region" text,
	"region_key" text,
	"min_price" bigint NOT NULL,
	"max_price" bigint NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_bands_min_non_negative" CHECK ("price_bands"."min_price" >= 0),
	CONSTRAINT "price_bands_bounds" CHECK ("price_bands"."max_price" >= "price_bands"."min_price"),
	CONSTRAINT "price_bands_region_key_paired" CHECK (("price_bands"."region" is null) = ("price_bands"."region_key" is null))
);
--> statement-breakpoint
DROP INDEX "partner_rates_lookup_idx";--> statement-breakpoint
ALTER TABLE "partner_rates" ADD COLUMN "region_key" text;--> statement-breakpoint
-- Разовое заполнение ключа у уже заведённых цен. Выражение — приближение
-- к `normalizeRegion` и на точность не претендует: расхождение оставит строку ровно
-- настолько же достижимой, насколько она была до миграции (регион сравнивался строкой
-- и при другом написании молча подменялся общей ценой). Новые строки получают ключ
-- от приложения — единственной функцией, как того требует ADR-0022.
UPDATE "partner_rates"
   SET "region_key" = coalesce(
     nullif(
       btrim(
         regexp_replace(
           regexp_replace(lower(replace("region", 'ё', 'е')), '[.,()]', ' ', 'g'),
           '(^|\s)(автономный округ|автономная область|область|обл|край|кр|республика|респ|округ|окр|город|район|ао|г)(\s|$)',
           ' ',
           'g'
         )
       ),
       ''
     ),
     btrim(lower("region"))
   )
 WHERE "region" is not null;--> statement-breakpoint
ALTER TABLE "price_bands" ADD CONSTRAINT "price_bands_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_bands_lookup_idx" ON "price_bands" USING btree ("operator_id","region_key","effective_from");--> statement-breakpoint
CREATE INDEX "partner_rates_lookup_idx" ON "partner_rates" USING btree ("partner_id","operator_id","region_key","effective_from");--> statement-breakpoint
ALTER TABLE "partner_rates" ADD CONSTRAINT "partner_rates_region_key_paired" CHECK (("partner_rates"."region" is null) = ("partner_rates"."region_key" is null));