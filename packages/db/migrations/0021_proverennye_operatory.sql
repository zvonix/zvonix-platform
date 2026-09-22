ALTER TABLE "operators" ADD COLUMN "verified_at" timestamp with time zone;
--> statement-breakpoint
-- Записи, существовавшие до этой миграции, завёл администратор руками: он и есть
-- человек, который их подтвердил (ADR-0032). Без этой строки они стали бы
-- непроверенными разом, и вызовы по ним перестали бы совершаться.
UPDATE "operators" SET "verified_at" = "created_at" WHERE "verified_at" IS NULL;
