-- AlterTable
ALTER TABLE "AdAccount" ADD COLUMN     "capAppliedAt" TIMESTAMP(3),
ADD COLUMN     "capDirty" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "capLockedUntil" TIMESTAMP(3),
ADD COLUMN     "capMinor" INTEGER,
ADD COLUMN     "catalogId" TEXT,
ADD COLUMN     "conversionActionId" TEXT,
ADD COLUMN     "conversionTag" TEXT,
ADD COLUMN     "dataSourceId" TEXT,
ADD COLUMN     "feedStatus" JSONB,
ADD COLUMN     "feedSyncedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lifetimeSpendCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "merchantCenterId" TEXT,
ADD COLUMN     "provisionKey" TEXT,
ADD COLUMN     "provisionLockedUntil" TIMESTAMP(3),
ADD COLUMN     "provisionStatus" TEXT NOT NULL DEFAULT 'ready';

-- AlterTable
ALTER TABLE "AdCampaign" ADD COLUMN     "externalRefs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "groupId" TEXT;

-- AlterTable
ALTER TABLE "AdCreative" ADD COLUMN     "assets" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "BoostGroup" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "storeProductId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "channels" "AdChannel"[],
    "dailyBudgetCents" INTEGER NOT NULL DEFAULT 0,
    "split" JSONB NOT NULL DEFAULT '{}',
    "variants" JSONB NOT NULL DEFAULT '[]',
    "assets" JSONB NOT NULL DEFAULT '[]',
    "variantIndex" INTEGER NOT NULL DEFAULT 0,
    "policyResult" TEXT NOT NULL DEFAULT 'pending',
    "autoLadder" BOOLEAN NOT NULL DEFAULT true,
    "ladderStep" INTEGER NOT NULL DEFAULT 0,
    "pickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "launchRequestedAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "launchMs" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoostGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyCheck" (
    "id" TEXT NOT NULL,
    "groupId" TEXT,
    "creativeId" TEXT,
    "rules" TEXT[],
    "result" TEXT NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL DEFAULT 'storeforge',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdReconcile" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "platformSpendCents" INTEGER NOT NULL,
    "chargedSpendCents" INTEGER NOT NULL,
    "driftBps" INTEGER NOT NULL,
    "adjustedCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdReconcile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionDelivery" (
    "id" TEXT NOT NULL,
    "conversionEventId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "channel" "AdChannel" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "trace" TEXT,
    "testCode" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversionDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoostGroup_status_idx" ON "BoostGroup"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BoostGroup_storeId_requestId_key" ON "BoostGroup"("storeId", "requestId");

-- CreateIndex
CREATE INDEX "PolicyCheck_groupId_idx" ON "PolicyCheck"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "AdReconcile_campaignId_date_key" ON "AdReconcile"("campaignId", "date");

-- CreateIndex
CREATE INDEX "ConversionDelivery_status_nextAttemptAt_idx" ON "ConversionDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionDelivery_conversionEventId_adAccountId_key" ON "ConversionDelivery"("conversionEventId", "adAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_provisionKey_key" ON "AdAccount"("provisionKey");

-- CreateIndex
CREATE INDEX "AdCampaign_groupId_idx" ON "AdCampaign"("groupId");

-- AddForeignKey
ALTER TABLE "BoostGroup" ADD CONSTRAINT "BoostGroup_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyCheck" ADD CONSTRAINT "PolicyCheck_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BoostGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdReconcile" ADD CONSTRAINT "AdReconcile_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionDelivery" ADD CONSTRAINT "ConversionDelivery_conversionEventId_fkey" FOREIGN KEY ("conversionEventId") REFERENCES "ConversionEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionDelivery" ADD CONSTRAINT "ConversionDelivery_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "BoostGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Money/counter invariants (backstops; the services never write these)
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_cap_nonneg" CHECK ("capMinor" IS NULL OR "capMinor" >= 0);
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_lifetime_spend_nonneg" CHECK ("lifetimeSpendCents" >= 0);
ALTER TABLE "BoostGroup" ADD CONSTRAINT "BoostGroup_budget_nonneg" CHECK ("dailyBudgetCents" >= 0 AND "ladderStep" >= 0);
ALTER TABLE "AdReconcile" ADD CONSTRAINT "AdReconcile_nonneg" CHECK ("platformSpendCents" >= 0 AND "chargedSpendCents" >= 0 AND "driftBps" >= 0);
ALTER TABLE "ConversionDelivery" ADD CONSTRAINT "ConversionDelivery_attempts_nonneg" CHECK ("attempts" >= 0);
ALTER TABLE "AdAccount" ADD COLUMN "billingRef" TEXT;
