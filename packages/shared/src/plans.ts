export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUsd: 29,
    maxStores: 1,
    maxOrdersPerMonth: 100,
    description: '1 store, catalog import, basic fulfillment',
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceUsd: 79,
    maxStores: 3,
    maxOrdersPerMonth: 500,
    description: '3 stores, higher limits, email tools later',
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    priceUsd: 199,
    maxStores: 10,
    maxOrdersPerMonth: 5000,
    description: 'Multi-store, priority routing, API later',
  },
} as const;

export type PlanId = keyof typeof PLANS;
