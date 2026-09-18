import { z } from 'zod';

export const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(120),
  accountName: z.string().min(1).max(120).optional(),
});

export const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const CreateStoreSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case'),
});

export const ImportProductsSchema = z.object({
  productIds: z.array(z.string().cuid()).min(1).max(100),
  markupPercent: z.number().min(0).max(500).default(50),
});

export const CheckoutSchema = z.object({
  storeSlug: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  lines: z
    .array(
      z.object({
        storeProductId: z.string(),
        quantity: z.number().int().min(1).max(99),
      }),
    )
    .min(1),
  shippingAddress: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().min(1),
    postalCode: z.string().min(1),
    country: z.string().min(2).max(2).default('US'),
  }),
});

export const ApproveFulfillmentSchema = z.object({
  orderId: z.string(),
});

export type SignUpInput = z.infer<typeof SignUpSchema>;
export type SignInInput = z.infer<typeof SignInSchema>;
export type CreateStoreInput = z.infer<typeof CreateStoreSchema>;
export type ImportProductsInput = z.infer<typeof ImportProductsSchema>;
export type CheckoutInput = z.infer<typeof CheckoutSchema>;
