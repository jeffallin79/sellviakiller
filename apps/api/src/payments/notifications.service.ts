import { Injectable, Logger } from '@nestjs/common';
import { prisma, Prisma } from '@storeforge/db';

export type NotifyInput = {
  organizationId: string | null; // null = platform / ops alert
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  orderId?: string | null;
  dedupeKey: string;
};

/**
 * In-app alerts for merchants (Launchpad) and the platform (organizationId = null, also logged
 * at error level so log alerting picks it up). Exactly-once per dedupeKey.
 * Merchant email for these arrives with the email module (slice 2).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  async notify(n: NotifyInput) {
    if (n.organizationId === null || n.severity === 'critical') {
      this.logger.error(`[ALERT] ${n.kind}: ${n.title} — ${n.body}${n.orderId ? ` (order ${n.orderId})` : ''}`);
    }
    try {
      return await prisma.notification.create({
        data: { organizationId: n.organizationId, kind: n.kind, severity: n.severity ?? 'warning', title: n.title, body: n.body, orderId: n.orderId ?? null, dedupeKey: n.dedupeKey },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null; // already notified
      throw e;
    }
  }

  list(organizationId: string, take = 20) {
    return prisma.notification.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take });
  }

  markRead(organizationId: string, id: string) {
    return prisma.notification.updateMany({ where: { id, organizationId, readAt: null }, data: { readAt: new Date() } });
  }
}
