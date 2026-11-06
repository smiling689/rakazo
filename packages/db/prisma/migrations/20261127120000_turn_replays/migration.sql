-- Additive: older releases never read or write this table.
CREATE TABLE "turn_replays" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "messageId" TEXT,
    "text" TEXT NOT NULL,
    "context" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "noteBytes" INTEGER NOT NULL DEFAULT 0,
    "prefixKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_replays_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "turn_replays_runId_key" ON "turn_replays"("runId");

CREATE INDEX "turn_replays_threadId_botId_createdAt_idx" ON "turn_replays"("threadId", "botId", "createdAt");

CREATE INDEX "turn_replays_threadId_messageId_idx" ON "turn_replays"("threadId", "messageId");

CREATE INDEX "turn_replays_spaceId_idx" ON "turn_replays"("spaceId");

CREATE INDEX "turn_replays_botId_idx" ON "turn_replays"("botId");

ALTER TABLE "turn_replays" ADD CONSTRAINT "turn_replays_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "turn_replays" ADD CONSTRAINT "turn_replays_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "turn_replays" ADD CONSTRAINT "turn_replays_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "turn_replays" ENABLE ROW LEVEL SECURITY;
CREATE POLICY turn_replays_tenant ON "turn_replays"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY turn_replays_system ON "turn_replays"
  USING ((SELECT app_rls_bypass()));
