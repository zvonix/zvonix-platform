CREATE TABLE "node_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"take_before" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"reply" text
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "commands_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "node_commands" ADD CONSTRAINT "node_commands_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_commands_waiting_idx" ON "node_commands" USING btree ("node_id","created_at") WHERE "node_commands"."taken_at" is null;--> statement-breakpoint
CREATE INDEX "node_commands_created_idx" ON "node_commands" USING btree ("created_at");