-- QA hardening (2026-11-12): webhook claim lease, order/store flags, disputes, notifications,
-- refund reconcile fields, and CHECK constraints so wallet balances can never go negative.
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "flag" TEXT,
ADD COLUMN     "flagDetail" TEXT,
ADD COLUMN     "flaggedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "riskFlag" TEXT,
ADD COLUMN     "riskFlaggedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WalletTxn" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "reconciledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerDisputeId" TEXT NOT NULL,
    "chargeId" TEXT,
    "paymentIntentId" TEXT,
    "orderId" TEXT,
    "storeId" TEXT,
    "organizationId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL,
    "evidenceDueBy" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "orderId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_providerDisputeId_key" ON "Dispute"("providerDisputeId");

-- CreateIndex
CREATE INDEX "Dispute_orderId_idx" ON "Dispute"("orderId");

-- CreateIndex
CREATE INDEX "Dispute_organizationId_idx" ON "Dispute"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt");


-- Wallet balances can never be negative (spend/refund races fail at the database).
ALTER TABLE "AdWallet" ADD CONSTRAINT "AdWallet_balance_nonnegative" CHECK ("balanceCents" >= 0);
ALTER TABLE "AdWallet" ADD CONSTRAINT "AdWallet_bonus_nonnegative" CHECK ("bonusCents" >= 0);
