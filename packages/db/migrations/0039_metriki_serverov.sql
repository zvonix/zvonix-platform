CREATE TABLE "server_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid,
	"taken_at" timestamp with time zone NOT NULL,
	"load1_centi" integer NOT NULL,
	"cpu_cores" integer NOT NULL,
	"mem_total_mb" integer NOT NULL,
	"mem_available_mb" integer NOT NULL,
	"disk_total_mb" integer NOT NULL,
	"disk_free_mb" integer NOT NULL,
	"active_calls" integer,
	CONSTRAINT "server_metrics_non_negative" CHECK ("server_metrics"."load1_centi" >= 0 and "server_metrics"."cpu_cores" >= 1 and "server_metrics"."mem_total_mb" >= 0 and "server_metrics"."mem_available_mb" >= 0 and "server_metrics"."disk_total_mb" >= 0 and "server_metrics"."disk_free_mb" >= 0)
);
--> statement-breakpoint
ALTER TABLE "server_metrics" ADD CONSTRAINT "server_metrics_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_metrics_source_time_idx" ON "server_metrics" USING btree ("node_id","taken_at");--> statement-breakpoint
CREATE INDEX "server_metrics_time_idx" ON "server_metrics" USING btree ("taken_at");