CREATE TABLE "messenger_tariffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price" bigint NOT NULL,
	"limit_per_minute" integer,
	"limit_per_day" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messenger_tariffs_name_length" CHECK (char_length("messenger_tariffs"."name") between 1 and 60),
	CONSTRAINT "messenger_tariffs_price_positive" CHECK ("messenger_tariffs"."price" > 0),
	CONSTRAINT "messenger_tariffs_limits_positive" CHECK (("messenger_tariffs"."limit_per_minute" is null or "messenger_tariffs"."limit_per_minute" > 0) and ("messenger_tariffs"."limit_per_day" is null or "messenger_tariffs"."limit_per_day" > 0))
);
--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD COLUMN "tariff_id" uuid;--> statement-breakpoint
ALTER TABLE "messenger_tariffs" ADD CONSTRAINT "messenger_tariffs_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_tariffs_partner_name_idx" ON "messenger_tariffs" USING btree ("partner_id",lower("name" collate "und-x-icu"));--> statement-breakpoint
CREATE UNIQUE INDEX "messenger_tariffs_default_idx" ON "messenger_tariffs" USING btree ("partner_id") WHERE "messenger_tariffs"."is_default";--> statement-breakpoint
ALTER TABLE "messenger_accounts" ADD CONSTRAINT "messenger_accounts_tariff_id_messenger_tariffs_id_fk" FOREIGN KEY ("tariff_id") REFERENCES "public"."messenger_tariffs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messenger_accounts_tariff_idx" ON "messenger_accounts" USING btree ("tariff_id");--> statement-breakpoint
-- Данные (ADR-0075): условия живых аккаунтов становятся тарифами. Самое частое сочетание партнёра — «Основной» и по
-- умолчанию (аккаунты с ним тариф не назначают и идут за умолчанием), остальные — «Тариф 2», «Тариф 3»…
WITH combos AS (
  SELECT partner_id, price, limit_per_minute, limit_per_day,
         count(*) AS uses, min(created_at) AS first_at
  FROM messenger_accounts
  WHERE status <> 'retired' AND price IS NOT NULL
  GROUP BY partner_id, price, limit_per_minute, limit_per_day
), ranked AS (
  SELECT combos.*, row_number() OVER (PARTITION BY partner_id ORDER BY uses DESC, first_at, price) AS n
  FROM combos
), inserted AS (
  INSERT INTO messenger_tariffs (id, partner_id, name, price, limit_per_minute, limit_per_day, is_default)
  SELECT gen_random_uuid(), partner_id,
         CASE WHEN n = 1 THEN 'Основной' ELSE 'Тариф ' || n::text END,
         price, limit_per_minute, limit_per_day, n = 1
  FROM ranked
  RETURNING id, partner_id, price, limit_per_minute, limit_per_day, is_default
)
UPDATE messenger_accounts a SET tariff_id = i.id
FROM inserted i
WHERE NOT i.is_default AND a.status <> 'retired' AND a.partner_id = i.partner_id AND a.price = i.price
  AND a.limit_per_minute IS NOT DISTINCT FROM i.limit_per_minute
  AND a.limit_per_day IS NOT DISTINCT FROM i.limit_per_day;--> statement-breakpoint
-- Аккаунты без своего тарифа берут условия тарифа по умолчанию (в том числе прежде без цены).
UPDATE messenger_accounts a
SET price = t.price, limit_per_minute = t.limit_per_minute, limit_per_day = t.limit_per_day
FROM messenger_tariffs t
WHERE t.partner_id = a.partner_id AND t.is_default AND a.tariff_id IS NULL AND a.status <> 'retired';
