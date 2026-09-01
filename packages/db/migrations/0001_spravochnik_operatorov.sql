CREATE TABLE "number_resolutions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"msisdn" text NOT NULL,
	"operator_id" uuid NOT NULL,
	"previous_operator_id" uuid,
	"region" text,
	"source" text NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "number_resolutions_source_check" CHECK ("number_resolutions"."source" in ('lookup', 'numbering_plan', 'manual')),
	CONSTRAINT "number_resolutions_msisdn_format" CHECK ("number_resolutions"."msisdn" ~ '^7[0-9]{10}$'),
	CONSTRAINT "number_resolutions_ttl" CHECK ("number_resolutions"."expires_at" > "number_resolutions"."resolved_at"),
	CONSTRAINT "number_resolutions_previous_differs" CHECK ("number_resolutions"."previous_operator_id" is null or "number_resolutions"."previous_operator_id" <> "number_resolutions"."operator_id")
);
--> statement-breakpoint
CREATE TABLE "numbering_plan_ranges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"def_code" text NOT NULL,
	"range_start" bigint NOT NULL,
	"range_end" bigint NOT NULL,
	"capacity" integer NOT NULL,
	"operator_id" uuid NOT NULL,
	"region" text,
	"source" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "numbering_plan_ranges_source_check" CHECK ("numbering_plan_ranges"."source" in ('nic_t', 'mincifry')),
	CONSTRAINT "numbering_plan_ranges_bounds" CHECK ("numbering_plan_ranges"."range_start" <= "numbering_plan_ranges"."range_end"),
	CONSTRAINT "numbering_plan_ranges_capacity" CHECK ("numbering_plan_ranges"."capacity" > 0)
);
--> statement-breakpoint
CREATE TABLE "operator_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_aliases_normalized" CHECK ("operator_aliases"."alias" = lower("operator_aliases"."alias"))
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"inn" text,
	"mnc" text,
	"is_mvno" boolean DEFAULT false NOT NULL,
	"host_operator_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_mvno_has_host" CHECK (("operators"."is_mvno" = false and "operators"."host_operator_id" is null) or ("operators"."is_mvno" = true and "operators"."host_operator_id" is not null)),
	CONSTRAINT "operators_host_is_other" CHECK ("operators"."host_operator_id" is null or "operators"."host_operator_id" <> "operators"."id")
);
--> statement-breakpoint
ALTER TABLE "number_resolutions" ADD CONSTRAINT "number_resolutions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_resolutions" ADD CONSTRAINT "number_resolutions_previous_operator_id_operators_id_fk" FOREIGN KEY ("previous_operator_id") REFERENCES "public"."operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numbering_plan_ranges" ADD CONSTRAINT "numbering_plan_ranges_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_aliases" ADD CONSTRAINT "operator_aliases_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_host_operator_id_operators_id_fk" FOREIGN KEY ("host_operator_id") REFERENCES "public"."operators"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "number_resolutions_msisdn_key" ON "number_resolutions" USING btree ("msisdn");--> statement-breakpoint
CREATE INDEX "number_resolutions_refresh_idx" ON "number_resolutions" USING btree ("expires_at","last_used_at");--> statement-breakpoint
CREATE INDEX "number_resolutions_operator_idx" ON "number_resolutions" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "numbering_plan_ranges_key" ON "numbering_plan_ranges" USING btree ("source","range_start","range_end");--> statement-breakpoint
CREATE INDEX "numbering_plan_ranges_lookup_idx" ON "numbering_plan_ranges" USING btree ("range_start","range_end");--> statement-breakpoint
CREATE INDEX "numbering_plan_ranges_operator_idx" ON "numbering_plan_ranges" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_aliases_alias_key" ON "operator_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "operator_aliases_operator_idx" ON "operator_aliases" USING btree ("operator_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_name_key" ON "operators" USING btree ("name");--> statement-breakpoint
CREATE INDEX "operators_inn_idx" ON "operators" USING btree ("inn");--> statement-breakpoint
CREATE INDEX "operators_mnc_idx" ON "operators" USING btree ("mnc");