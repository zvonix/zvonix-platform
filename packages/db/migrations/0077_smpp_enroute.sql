ALTER TABLE "smpp_accounts" DROP CONSTRAINT "smpp_accounts_receipt_on_sent_check";--> statement-breakpoint
ALTER TABLE "smpp_accounts" DROP CONSTRAINT "smpp_accounts_receipt_on_delivered_check";--> statement-breakpoint
ALTER TABLE "smpp_accounts" DROP CONSTRAINT "smpp_accounts_receipt_on_read_check";--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_receipt_on_sent_check" CHECK ("smpp_accounts"."receipt_on_sent" in ('none', 'enroute', 'accepted', 'delivered'));--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_receipt_on_delivered_check" CHECK ("smpp_accounts"."receipt_on_delivered" in ('none', 'enroute', 'accepted', 'delivered'));--> statement-breakpoint
ALTER TABLE "smpp_accounts" ADD CONSTRAINT "smpp_accounts_receipt_on_read_check" CHECK ("smpp_accounts"."receipt_on_read" in ('none', 'enroute', 'accepted', 'delivered'));