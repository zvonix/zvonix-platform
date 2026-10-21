ALTER TABLE "support_tickets" ADD COLUMN "author_read_at" timestamp with time zone;--> statement-breakpoint
-- Прежние обращения считаются прочитанными: иначе у каждого автора сразу загорелось бы число «есть ответ».
UPDATE "support_tickets" SET "author_read_at" = now();
