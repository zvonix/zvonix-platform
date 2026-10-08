ALTER TABLE "messages" DROP CONSTRAINT "messages_amounts_check";--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "partner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "route" text DEFAULT 'account' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_bot_id_messenger_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."messenger_bots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_route_check" CHECK ("messages"."route" in ('account', 'bot'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_route_owner_check" CHECK (("messages"."route" = 'account' and "messages"."account_id" is not null and "messages"."partner_id" is not null and "messages"."bot_id" is null)
        or ("messages"."route" = 'bot' and "messages"."bot_id" is not null and "messages"."account_id" is null and "messages"."partner_id" is null));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_amounts_check" CHECK ("messages"."commission_amount" >= 0 and "messages"."client_amount" = "messages"."partner_amount" + "messages"."commission_amount"
        and (("messages"."route" = 'account' and "messages"."partner_amount" > 0) or ("messages"."route" = 'bot' and "messages"."partner_amount" = 0)));