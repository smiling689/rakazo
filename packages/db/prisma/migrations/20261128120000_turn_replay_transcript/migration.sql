-- Additive: older releases neither read nor write this column.
ALTER TABLE "turn_replays" ADD COLUMN "transcript" TEXT;
