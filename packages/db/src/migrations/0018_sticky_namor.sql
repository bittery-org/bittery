DROP INDEX "sync_event_createdAt_id_idx";--> statement-breakpoint
ALTER TABLE "sync_event" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_event_seq_idx" ON "sync_event" USING btree ("seq");