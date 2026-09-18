import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { prisma } from '@storeforge/db';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: {
    enabled: true,
  },
  secret: process.env.BETTER_AUTH_SECRET ?? 'dev-secret-change-me-32chars-min!!',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:4000',
  basePath: '/api/auth',
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? 'http://localhost:3000,http://localhost:3001')
    .split(',')
    .map((s) => s.trim()),
});

export type Session = typeof auth.$Infer.Session;
