-- CreateEnum
CREATE TYPE "CartStatus" AS ENUM ('OPEN', 'CONVERTED', 'OPTED_OUT', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EmailKind" ADD VALUE 'CART_REMINDER_1';
ALTER TYPE "EmailKind" ADD VALUE 'CART_REMINDER_2';

-- AlterEnum
ALTER TYPE "EmailStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "cartId" TEXT,
ADD COLUMN     "headers" JSONB;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "cartRecovery" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "mailingAddress" TEXT;

-- CreateTable
CREATE TABLE "Cart" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT,
    "emailHash" TEXT,
    "customerName" TEXT,
    "lines" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "consent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentText" TEXT,
    "status" "CartStatus" NOT NULL DEFAULT 'OPEN',
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminder1At" TIMESTAMP(3),
    "reminder2At" TIMESTAMP(3),
    "recoveredAt" TIMESTAMP(3),
    "orderId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "recoveredCents" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductScore" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "trendScore" INTEGER NOT NULL,
    "marginScore" INTEGER NOT NULL,
    "saturationScore" INTEGER NOT NULL,
    "etaScore" INTEGER NOT NULL,
    "keyword" TEXT NOT NULL,
    "orderVelocity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "searchIndex" INTEGER,
    "searchChange" DOUBLE PRECISION,
    "adCount" INTEGER,
    "profitCents" INTEGER NOT NULL,
    "marginPct" DOUBLE PRECISION NOT NULL,
    "breakEvenRoas" DOUBLE PRECISION,
    "sources" JSONB NOT NULL,
    "inputs" JSONB NOT NULL,
    "insight" TEXT NOT NULL DEFAULT '',
    "angles" JSONB,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Cart_status_lastActivityAt_idx" ON "Cart"("status", "lastActivityAt");

-- CreateIndex
CREATE INDEX "Cart_storeId_createdAt_idx" ON "Cart"("storeId", "createdAt");

-- CreateIndex
CREATE INDEX "Cart_storeId_emailHash_idx" ON "Cart"("storeId", "emailHash");

-- CreateIndex
CREATE INDEX "Cart_orderId_idx" ON "Cart"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Cart_storeId_token_key" ON "Cart"("storeId", "token");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_storeId_emailHash_key" ON "EmailSuppression"("storeId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProductScore_productId_key" ON "ProductScore"("productId");

-- CreateIndex
CREATE INDEX "ProductScore_score_idx" ON "ProductScore"("score");

-- CreateIndex
CREATE INDEX "EmailMessage_cartId_idx" ON "EmailMessage"("cartId");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_cartId_fkey" FOREIGN KEY ("cartId") REFERENCES "Cart"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cart" ADD CONSTRAINT "Cart_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductScore" ADD CONSTRAINT "ProductScore_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

