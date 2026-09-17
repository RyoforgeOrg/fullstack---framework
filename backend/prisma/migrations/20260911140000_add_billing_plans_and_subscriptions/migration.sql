-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'incomplete');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMonthlyCents" INTEGER NOT NULL DEFAULT 0,
    "stripePriceId" TEXT,
    "features" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhookEvent" (
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_key_key" ON "Plan"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_stripeSubscriptionId_key" ON "Subscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "Subscription_planId_idx" ON "Subscription"("planId");

-- CreateIndex
CREATE INDEX "Subscription_stripeCustomerId_idx" ON "Subscription"("stripeCustomerId");

-- CreateIndex
CREATE INDEX "ProcessedWebhookEvent_processedAt_idx" ON "ProcessedWebhookEvent"("processedAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT (Prisma's default for a required relation): a Plan row that orgs are
-- currently subscribed to must not be deletable. Retire a plan by removing its
-- stripePriceId so it can no longer be checked out, not by deleting the row.
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SEED (idempotent) — the plan catalogue.
-- Seeded here rather than in a separate seed script because the code REQUIRES a
-- 'free' plan row to exist: every organization gets a free Subscription at
-- creation time, so an unseeded database is a broken database, not an empty one.
-- ON CONFLICT DO NOTHING keeps `migrate deploy` safe to re-run and never
-- overwrites prices/features an operator has since edited in production.
-- stripePriceId is left NULL for paid plans on purpose: the real price ids are
-- created in the Stripe dashboard per environment and set with an UPDATE (or via
-- STRIPE_PRICE_ID_* env, see helpers/billingProvider.js) — hardcoding a test-mode
-- id here would silently ship into production.
INSERT INTO "Plan" ("id", "key", "name", "priceMonthlyCents", "stripePriceId", "features")
VALUES
  ('plan_free', 'free', 'Free', 0, NULL,
   '{"maxMembers": 3, "maxFiles": 25, "apiAccess": false, "prioritySupport": false}'),
  ('plan_pro', 'pro', 'Pro', 2900, NULL,
   '{"maxMembers": 25, "maxFiles": 1000, "apiAccess": true, "prioritySupport": false}'),
  ('plan_enterprise', 'enterprise', 'Enterprise', 9900, NULL,
   '{"maxMembers": -1, "maxFiles": -1, "apiAccess": true, "prioritySupport": true}')
ON CONFLICT ("key") DO NOTHING;

-- Backfill: organizations that predate billing get the free plan, matching what
-- OrganizationService now creates for every new org.
INSERT INTO "Subscription" ("id", "organizationId", "planId", "status", "createdAt", "updatedAt")
SELECT 'sub_' || o."id", o."id", 'plan_free', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Organization" o
WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."organizationId" = o."id");
