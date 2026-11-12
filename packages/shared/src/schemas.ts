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
  /**
   * Ad attribution captured by the storefront (slice 3). `consent` = the shopper accepted marketing
   * cookies in the banner; without it no Pixel loads and no Conversions API event is sent.
   * IP and user agent are added server-side from the request.
   */
  attribution: z
    .object({
      consent: z.boolean().default(false),
      fbp: z.string().max(200).regex(/^fb\.\d\.\d+\.[\w.-]+$/).optional(),
      fbc: z.string().max(500).regex(/^fb\.\d\.\d+\.[\w.-]+$/).optional(),
      sourceUrl: z.string().url().max(2000).optional(),
      /** Google Ads click id (?gclid=) and TikTok click id (?ttclid=) + _ttp cookie (slice 4) */
      gclid: z.string().max(300).regex(/^[\w-]+$/).optional(),
      ttclid: z.string().max(500).regex(/^[\w.-]+$/).optional(),
      ttp: z.string().max(200).regex(/^[\w.-]+$/).optional(),
    })
    .optional(),
  /** Slice 5: the storefront's cart id, so a paid checkout closes its abandoned-cart reminders */
  cartToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  /** Slice 5: the shopper ticked "email me a reminder" (stored with the exact wording) */
  cartConsent: z.boolean().optional(),
});

export const ApproveFulfillmentSchema = z.object({
  orderId: z.string(),
});

export type SignUpInput = z.infer<typeof SignUpSchema>;
export type SignInInput = z.infer<typeof SignInSchema>;
export type CreateStoreInput = z.infer<typeof CreateStoreSchema>;
export type ImportProductsInput = z.infer<typeof ImportProductsSchema>;
export type CheckoutInput = z.infer<typeof CheckoutSchema>;
