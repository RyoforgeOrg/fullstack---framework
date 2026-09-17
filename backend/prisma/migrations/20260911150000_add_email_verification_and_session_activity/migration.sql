-- Email verification (A03) + device-session activity (A04).
--
-- Both columns are nullable with no default, so this is a metadata-only change
-- on Postgres (no table rewrite) and is safe to apply to a live table.
--
-- NOTE: no backfill. Every pre-existing account stays emailVerifiedAt = NULL,
-- i.e. unverified. That is intentional: the only thing gated on verification is
-- organization creation (middleware/requireVerifiedEmail.js), never login, so an
-- existing user is never locked out — they are just asked to verify before
-- creating their first org. If your product seeds trusted accounts, backfill them
-- explicitly, e.g.:
--   UPDATE "User" SET "emailVerifiedAt" = now() WHERE "role" = 'superAdmin';

-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN "lastUsedAt" TIMESTAMP(3);
