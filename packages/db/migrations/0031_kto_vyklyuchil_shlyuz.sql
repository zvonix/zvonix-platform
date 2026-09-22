ALTER TABLE "gateways" ADD COLUMN "suspended_by" text;
--> statement-breakpoint
-- До ADR-0047 выключенный шлюз возвращал только администратор — так и остаётся для строк,
-- выключенных до этой миграции: ни один партнёр не получает права, о котором ему не говорили.
-- Истинная причина (партнёр, администратор или порог) есть только в журнале аудита, а читать
-- чужой модуль из миграции значило бы опираться на данные, которые пишутся «по возможности».
UPDATE "gateways" SET "suspended_by" = 'admin' WHERE "status" = 'suspended';
--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_suspended_by_check" CHECK ("gateways"."suspended_by" is null or "gateways"."suspended_by" in ('partner', 'admin', 'failure_threshold'));--> statement-breakpoint
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_suspended_by_matches_status" CHECK (("gateways"."status" = 'suspended') = ("gateways"."suspended_by" is not null));
