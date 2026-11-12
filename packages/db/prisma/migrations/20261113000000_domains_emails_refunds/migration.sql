-- Phase 1 slice 2: custom domains, customer emails, storefront order refunds.
-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_DNS', 'ISSUING_TLS', 'ACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailKind" AS ENUM ('ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_REFUNDED');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING_DNS',
    "verificationToken" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "tlsRequestedAt" TIMESTAMP(3),
    "tlsIssuedAt" TIMESTAMP(3),
    "tlsProvider" TEXT NOT NULL DEFAULT 'stub',
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "lastResult" JSONB,
    "lastError" TEXT,
    "devDnsSimulatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderRefund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT,
    "requestId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stub',
    "providerRefundId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "orderId" TEXT,
    "kind" "EmailKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "replyTo" TEXT,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL DEFAULT 'QUEUED',
    "transport" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Domain_host_key" ON "Domain"("host");

-- CreateIndex
CREATE INDEX "Domain_storeId_idx" ON "Domain"("storeId");

-- CreateIndex
CREATE INDEX "Domain_status_nextCheckAt_idx" ON "Domain"("status", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRefund_providerRefundId_key" ON "OrderRefund"("providerRefundId");

-- CreateIndex
CREATE INDEX "OrderRefund_orderId_idx" ON "OrderRefund"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRefund_orderId_requestId_key" ON "OrderRefund"("orderId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_dedupeKey_key" ON "EmailMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "EmailMessage_storeId_createdAt_idx" ON "EmailMessage"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_orderId_idx" ON "EmailMessage"("orderId");

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: Phase 0 stores that had Store.customDomain set get a Domain row that must
-- still pass DNS verification (nothing is served on it until it is ACTIVE).
INSERT INTO "Domain" ("id", "storeId", "host", "verificationToken", "isPrimary", "updatedAt")
SELECT 'dm' || substr(md5(random()::text || s."id"), 1, 23), s."id", lower(trim(trailing '.' from s."customDomain")),
       md5(random()::text || clock_timestamp()::text), true, CURRENT_TIMESTAMP
FROM "Store" s
WHERE s."customDomain" IS NOT NULL AND s."customDomain" <> '' AND s."deletedAt" IS NULL
ON CONFLICT ("host") DO NOTHING;
UPDATE "Store" SET "customDomain" = NULL WHERE "customDomain" IS NOT NULL;
