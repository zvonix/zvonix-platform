ALTER TABLE "calls" ADD COLUMN "cut_off_reason" text;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_cut_off_reason_check" CHECK ("calls"."cut_off_reason" in ('balance_exhausted'));