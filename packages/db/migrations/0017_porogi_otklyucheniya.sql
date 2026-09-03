CREATE TABLE "failure_thresholds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"failures" integer NOT NULL,
	"window_minutes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "failure_thresholds_scope_check" CHECK ("failure_thresholds"."scope" in ('sim', 'gateway')),
	CONSTRAINT "failure_thresholds_failures_min" CHECK ("failure_thresholds"."failures" >= 2),
	CONSTRAINT "failure_thresholds_window_positive" CHECK ("failure_thresholds"."window_minutes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "failure_thresholds_scope_key" ON "failure_thresholds" USING btree ("scope");