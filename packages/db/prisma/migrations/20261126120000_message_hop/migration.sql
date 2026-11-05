-- Additive: older releases never read or write it.
ALTER TABLE "messages" ADD COLUMN "hop" INTEGER;
