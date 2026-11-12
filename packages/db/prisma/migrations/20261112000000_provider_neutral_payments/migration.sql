-- Phase 1 step 0: Square -> Stripe. Payment columns become provider-neutral.
-- Columns are RENAMED (not dropped) so Phase 0 history survives; legacy rows are
-- tagged provider='square' (or 'stub' for Phase 0 stub ids).

-- Order: squarePaymentId -> providerPaymentId, squareOrderId -> providerCheckoutId
ALTER TABLE "Order" RENAME COLUMN "squarePaymentId" TO "providerPaymentId";
ALTER TABLE "Order" RENAME COLUMN "squareOrderId" TO "providerCheckoutId";
ALTER TABLE "Order" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stub',
ADD COLUMN "payoutAccountId" TEXT;
UPDATE "Order" SET "provider" = CASE WHEN "providerPaymentId" IS NULL OR "providerPaymentId" LIKE 'stub%' THEN 'stub' ELSE 'square' END;

-- Subscription
ALTER TABLE "Subscription" RENAME COLUMN "squareSubscriptionId" TO "providerSubscriptionId";
ALTER TABLE "Subscription" RENAME COLUMN "squareCustomerId" TO "providerCustomerId";
ALTER TABLE "Subscription" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'stub';
UPDATE "Subscription" SET "provider" = CASE WHEN "providerSubscriptionId" IS NULL OR "providerSubscriptionId" LIKE 'stub%' THEN 'stub' ELSE 'square' END;

-- Plan: Square catalog ids are meaningless to Stripe; keep column, clear values
ALTER TABLE "Plan" RENAME COLUMN "squareCatalogId" TO "providerPriceId";
UPDATE "Plan" SET "providerPriceId" = NULL;

-- CreateEnum
CREATE TYPE "WalletTxnKind" AS ENUM ('TOPUP', 'SPEND', 'FEE', 'REFUND', 'BONUS', 'ADJUST');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "billingCustomerId" TEXT,
ADD COLUMN     "payoutAccountId" TEXT,
ADD COLUMN     "payoutChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "payoutProvider" TEXT,
ADD COLUMN     "payoutUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdWallet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "bonusCents" INTEGER NOT NULL DEFAULT 0,
    "autoReloadCents" INTEGER NOT NULL DEFAULT 0,
    "thresholdCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTxn" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "kind" "WalletTxnKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stub',
    "providerPaymentId" TEXT,
    "providerRefundId" TEXT,
    "refundOfId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'succeeded',
    "campaignId" TEXT,
    "day" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTxn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookEvent_type_idx" ON "WebhookEvent"("type");

-- CreateIndex
CREATE UNIQUE INDEX "AdWallet_organizationId_key" ON "AdWallet"("organizationId");

-- CreateIndex
CREATE INDEX "WalletTxn_walletId_idx" ON "WalletTxn"("walletId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTxn_kind_providerPaymentId_key" ON "WalletTxn"("kind", "providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTxn_kind_providerRefundId_key" ON "WalletTxn"("kind", "providerRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_providerPaymentId_key" ON "Order"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_providerCheckoutId_key" ON "Order"("providerCheckoutId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_billingCustomerId_key" ON "Organization"("billingCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_payoutAccountId_key" ON "Organization"("payoutAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

-- AddForeignKey
ALTER TABLE "AdWallet" ADD CONSTRAINT "AdWallet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTxn" ADD CONSTRAINT "WalletTxn_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "AdWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

