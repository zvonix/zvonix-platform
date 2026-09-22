ALTER TABLE "calls" DROP CONSTRAINT "calls_destination_format";--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_destination_format" CHECK (case when "calls"."failure_reason" = 'destination_invalid'
            then "calls"."destination" ~ '^[0-9]*$'
            else "calls"."destination" ~ '^7[0-9]{10}$'
          end);