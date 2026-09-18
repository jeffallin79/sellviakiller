export const OrderStatus = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  AWAITING_MERCHANT_APPROVAL: 'AWAITING_MERCHANT_APPROVAL',
  FULFILLMENT_SUBMITTED: 'FULFILLMENT_SUBMITTED',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const FulfillmentStatus = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  SUBMITTED: 'SUBMITTED',
  SHIPPED: 'SHIPPED',
  FAILED: 'FAILED',
} as const;

export type FulfillmentStatus =
  (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

export const StoreStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  SOFT_DELETED: 'SOFT_DELETED',
} as const;

export type StoreStatus = (typeof StoreStatus)[keyof typeof StoreStatus];
