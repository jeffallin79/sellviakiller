-- CreateEnum
CREATE TYPE "AdChannel" AS ENUM ('META', 'GOOGLE', 'TIKTOK');

-- CreateEnum
CREATE TYPE "AdAccountMode" AS ENUM ('MANAGED', 'OWNED');

-- CreateEnum
CREATE TYPE "AdCampaignStage" AS ENUM ('DRAFT', 'REVIEW', 'WARMING', 'STEADY', 'PAUSED', 'REJECTED');

-- AlterTable
ALTER TABLE "AdWallet" ADD COLUMN     "autoReloadEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lowFuelAt" TIMESTAMP(3),
ADD COLUMN     "paymentMethodId" TEXT,
ADD COLUMN     "paymentMethodLabel" TEXT,
ADD COLUMN     "reloadAmountCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reloadFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reloadInFlight" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reloadLastError" TEXT,
ADD COLUMN     "reloadSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reloadStartedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "attribution" JSONB;

-- AlterTable
ALTER TABLE "WalletTxn" ADD COLUMN     "balanceAfterCents" INTEGER,
ADD COLUMN     "bonusAfterCents" INTEGER,
ADD COLUMN     "bonusCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "OAuthState" (
    "id" TEXT NOT NULL,
    "channel" "AdChannel" NOT NULL,
    "storeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdConnection" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" "AdChannel" NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "externalName" TEXT,
    "tokenCipher" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdAccount" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "channel" "AdChannel" NOT NULL,
    "mode" "AdAccountMode" NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "tokenRef" TEXT,
    "pixelId" TEXT,
    "pixelName" TEXT,
    "pageId" TEXT,
    "pageName" TEXT,
    "testEventCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCampaign" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "storeProductId" TEXT,
    "channel" "AdChannel" NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "externalAdSetId" TEXT,
    "externalAdId" TEXT,
    "externalCreativeId" TEXT,
    "dailyBudgetCents" INTEGER NOT NULL,
    "stage" "AdCampaignStage" NOT NULL DEFAULT 'DRAFT',
    "ladderStep" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT NOT NULL,
    "pausedReason" TEXT,
    "lastError" TEXT,
    "launchedAt" TIMESTAMP(3),
    "launchLockedUntil" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdCreative" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'image',
    "assetUrl" TEXT,
    "headline" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "policyStatus" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdCreative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdInsightDaily" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spendCents" INTEGER NOT NULL DEFAULT 0,
    "purchases" INTEGER NOT NULL DEFAULT 0,
    "revenueCents" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdInsightDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdChargeDay" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "spendOwedCents" INTEGER NOT NULL DEFAULT 0,
    "feeOwedCents" INTEGER NOT NULL DEFAULT 0,
    "spendDebitedCents" INTEGER NOT NULL DEFAULT 0,
    "feeDebitedCents" INTEGER NOT NULL DEFAULT 0,
    "shortfallCents" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdChargeDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversionEvent" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "sentMeta" BOOLEAN NOT NULL DEFAULT false,
    "sentGoogle" BOOLEAN NOT NULL DEFAULT false,
    "sentTikTok" BOOLEAN NOT NULL DEFAULT false,
    "metaStatus" TEXT NOT NULL DEFAULT 'pending',
    "metaTrace" TEXT,
    "testEventCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdConnection_storeId_channel_key" ON "AdConnection"("storeId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_storeId_channel_mode_key" ON "AdAccount"("storeId", "channel", "mode");

-- CreateIndex
CREATE INDEX "AdCampaign_stage_idx" ON "AdCampaign"("stage");

-- CreateIndex
CREATE UNIQUE INDEX "AdCampaign_storeId_requestId_key" ON "AdCampaign"("storeId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "AdInsightDaily_campaignId_date_key" ON "AdInsightDaily"("campaignId", "date");

-- CreateIndex
CREATE INDEX "AdChargeDay_walletId_idx" ON "AdChargeDay"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "AdChargeDay_campaignId_date_key" ON "AdChargeDay"("campaignId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionEvent_eventId_key" ON "ConversionEvent"("eventId");

-- CreateIndex
CREATE INDEX "ConversionEvent_storeId_idx" ON "ConversionEvent"("storeId");

-- AddForeignKey
ALTER TABLE "AdConnection" ADD CONSTRAINT "AdConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_tokenRef_fkey" FOREIGN KEY ("tokenRef") REFERENCES "AdConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdCreative" ADD CONSTRAINT "AdCreative_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdInsightDaily" ADD CONSTRAINT "AdInsightDaily_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdChargeDay" ADD CONSTRAINT "AdChargeDay_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversionEvent" ADD CONSTRAINT "ConversionEvent_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Money invariants (QA rule: the database refuses impossible states, not just the code)
ALTER TABLE "AdChargeDay" ADD CONSTRAINT "AdChargeDay_nonnegative" CHECK ("spendOwedCents" >= 0 AND "feeOwedCents" >= 0 AND "spendDebitedCents" >= 0 AND "feeDebitedCents" >= 0 AND "shortfallCents" >= 0);
ALTER TABLE "AdChargeDay" ADD CONSTRAINT "AdChargeDay_debited_le_owed" CHECK ("spendDebitedCents" <= "spendOwedCents" AND "feeDebitedCents" <= "feeOwedCents");
ALTER TABLE "AdWallet" ADD CONSTRAINT "AdWallet_reload_nonnegative" CHECK ("autoReloadCents" >= 0 AND "thresholdCents" >= 0);
ALTER TABLE "AdCampaign" ADD CONSTRAINT "AdCampaign_budget_positive" CHECK ("dailyBudgetCents" > 0);
