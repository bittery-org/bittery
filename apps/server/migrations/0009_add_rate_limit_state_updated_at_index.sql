CREATE INDEX IF NOT EXISTS "rate_limit_state_updated_at_idx" ON "rate_limit_state" USING btree ("updated_at");
