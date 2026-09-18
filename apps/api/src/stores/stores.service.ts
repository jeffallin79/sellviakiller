import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { prisma, StoreStatus } from '@storeforge/db';
import type { CreateStoreInput } from '@storeforge/shared';
import { PLANS } from '@storeforge/shared';

@Injectable()
export class StoresService {
  async create(organizationId: string, input: CreateStoreInput) {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: {
        subscription: { include: { plan: true } },
        stores: { where: { deletedAt: null } },
      },
    });

    if (!organization.subscription || organization.subscription.status !== 'ACTIVE') {
      if (!process.env.SQUARE_ACCESS_TOKEN) {
        await prisma.subscription.upsert({
          where: { organizationId },
          update: { status: 'ACTIVE', planId: 'starter' },
          create: {
            organizationId,
            planId: 'starter',
            status: 'ACTIVE',
            currentPeriodEnd: new Date(Date.now() + 30 * 86400000),
          },
        });
      } else {
        throw new BadRequestException('Active Square subscription required');
      }
    }

    const refreshed = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: {
        subscription: { include: { plan: true } },
        stores: { where: { deletedAt: null } },
      },
    });

    const maxStores =
      refreshed.subscription?.plan.maxStores ?? PLANS.starter.maxStores;
    if (refreshed.stores.length >= maxStores) {
      throw new BadRequestException(
        `Plan allows ${maxStores} store(s). Soft-delete or upgrade.`,
      );
    }

    // Soft-deleted stores must not block slug reuse
    const existing = await prisma.store.findFirst({
      where: { slug: input.slug, deletedAt: null },
    });
    if (existing) throw new BadRequestException('Slug already taken');

    const store = await prisma.store.create({
      data: {
        organizationId,
        name: input.name,
        slug: input.slug,
        status: StoreStatus.ACTIVE,
      },
    });

    const root = process.env.NEXT_PUBLIC_STOREFRONT_ROOT_DOMAIN ?? 'storeforge.local';
    return {
      ...store,
      url: `http://${store.slug}.${root}:3000`,
      note: 'Point *.storeforge.local to 127.0.0.1 in /etc/hosts for subdomain routing',
    };
  }

  async listForAccount(organizationId: string) {
    return prisma.store.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBySlug(slug: string) {
    const store = await prisma.store.findFirst({
      where: { slug, deletedAt: null, status: StoreStatus.ACTIVE },
    });
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async softDelete(organizationId: string, storeId: string) {
    const store = await prisma.store.findFirst({ where: { id: storeId, organizationId } });
    if (!store) throw new NotFoundException('Store not found');
    if (store.deletedAt) return store;
    // Free the global unique slug so a new store can reuse it (partial-unique semantics).
    const freedSlug = `${store.slug}__deleted__${store.id}`;
    return prisma.store.update({
      where: { id: storeId },
      data: {
        status: StoreStatus.SOFT_DELETED,
        deletedAt: new Date(),
        slug: freedSlug,
      },
    });
  }

  async assertOwned(organizationId: string, storeId: string) {
    const store = await prisma.store.findFirst({
      where: { id: storeId, organizationId, deletedAt: null },
    });
    if (!store) throw new ForbiddenException('Store not owned by account');
    return store;
  }
}
