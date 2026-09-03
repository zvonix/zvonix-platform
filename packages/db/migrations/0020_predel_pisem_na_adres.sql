CREATE INDEX "outbox_messages_recipient_idx" ON "outbox_messages" USING btree ("recipient","created_at");
