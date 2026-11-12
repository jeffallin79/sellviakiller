-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "verifiedIp" TEXT;

-- AlterTable
ALTER TABLE "EmailMessage" ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderRefund" ADD COLUMN     "reconciledAt" TIMESTAMP(3);

-- QA round 2 #6: an order can never be refunded below zero or past what was paid.
-- (totalCents is the amount charged; Stripe refunds are reserved here before they're sent.)
ALTER TABLE "Order" ADD CONSTRAINT "Order_refunded_within_paid" CHECK ("refundedCents" >= 0 AND "refundedCents" <= "totalCents");
