CREATE TABLE "blocked_numbers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_numbers_prefix_format" CHECK ("blocked_numbers"."prefix" ~ '^7[0-9]{3,10}$'),
	CONSTRAINT "blocked_numbers_note_not_empty" CHECK (length(btrim("blocked_numbers"."note")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_numbers_prefix_key" ON "blocked_numbers" USING btree ("prefix");