import { Injectable, BadRequestException } from '@nestjs/common';
import { prisma } from '@storeforge/db';
import type { SignUpInput } from '@storeforge/shared';
import { auth } from './better-auth';

@Injectable()
export class AuthService {
  async signUpAndCreateAccount(input: SignUpInput) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new BadRequestException('Email already registered');

    const result = await auth.api.signUpEmail({
      body: {
        email: input.email,
        password: input.password,
        name: input.name,
      },
    });

    const userId = result.user.id;
    const organization = await prisma.organization.create({
      data: {
        name: input.accountName ?? `${input.name}'s Account`,
        members: {
          create: { userId, role: 'owner' },
        },
      },
    });

    return {
      user: { id: userId, email: input.email, name: input.name },
      account: { id: organization.id, name: organization.name },
      message: 'Signed up. Use Better Auth sign-in, then POST /api/billing/subscribe.',
    };
  }

  async getMe(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: {
          include: {
            organization: {
              include: {
                subscription: { include: { plan: true } },
                stores: { where: { deletedAt: null } },
              },
            },
          },
        },
      },
    });
    // Shape compatible with admin UI expecting memberships[].account
    // Never expose password hashes or Better Auth credential secrets.
    const { passwordHash: _pw, ...safeUser } = user;
    return {
      ...safeUser,
      memberships: user.memberships.map((m) => ({
        ...m,
        account: m.organization,
      })),
    };
  }

  async requireAccountId(userId: string) {
    const membership = await prisma.organizationMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new BadRequestException('No account for user');
    return membership.organizationId;
  }
}
