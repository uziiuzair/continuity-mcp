-- Repair data written before the unique index existed: keep only the newest
-- active decision per key, superseding the rest, so the index can build.
UPDATE "decisions" SET "status" = 'superseded'
WHERE "status" = 'active' AND EXISTS (
  SELECT 1 FROM "decisions" d2
  WHERE d2."decision_key" = "decisions"."decision_key" AND d2."status" = 'active'
    AND (d2."created_at" > "decisions"."created_at"
      OR (d2."created_at" = "decisions"."created_at" AND d2."id" > "decisions"."id"))
);--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_active_key_uq" ON "decisions" USING btree ("decision_key") WHERE status = 'active';
