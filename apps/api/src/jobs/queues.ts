import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

let connection: IORedis | null = null;

export function getRedis() {
  if (!connection) {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    connection = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
      retryStrategy: () => null, // do not reconnect in stub mode
    });
    connection.on('error', () => {
      /* swallowed — initQueues handles availability */
    });
  }
  return connection;
}

export const QUEUE_ROUTE_FULFILLMENT = 'route-fulfillment';
export const QUEUE_TRACKING_POLL = 'tracking-poll';
/** Blueprint §4: queue `email.send` */
export const QUEUE_EMAIL_SEND = 'email.send';

let routeQueue: Queue | null = null;
let trackingQueue: Queue | null = null;
let emailQueue: Queue | null = null;
let redisAvailable = false;

export async function initQueues() {
  try {
    const redis = getRedis();
    await redis.connect();
    await redis.ping();
    redisAvailable = true;
    routeQueue = new Queue(QUEUE_ROUTE_FULFILLMENT, { connection: redis });
    trackingQueue = new Queue(QUEUE_TRACKING_POLL, { connection: redis });
    emailQueue = new Queue(QUEUE_EMAIL_SEND, { connection: redis });
    console.log('BullMQ queues connected');
  } catch (err) {
    redisAvailable = false;
    try {
      connection?.disconnect();
    } catch {
      /* ignore */
    }
    connection = null;
    console.warn('Redis unavailable — jobs will run inline (stub mode)');
  }
}

export function isRedisUp() {
  return redisAvailable;
}

export async function enqueueRouteFulfillment(orderId: string) {
  if (redisAvailable && routeQueue) {
    await routeQueue.add(
      'route',
      { orderId },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
    );
    return { queued: true };
  }
  return { queued: false, inline: true };
}

export async function enqueueTrackingPoll(fulfillmentId: string) {
  if (redisAvailable && trackingQueue) {
    await trackingQueue.add('poll', { fulfillmentId }, { delay: 5000 });
    return { queued: true };
  }
  return { queued: false, inline: true };
}

export async function enqueueEmailSend(emailId: string) {
  if (redisAvailable && emailQueue) {
    // jobId = email id → enqueueing twice is a no-op
    await emailQueue.add('send', { emailId }, { jobId: emailId, attempts: 5, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: 1000 });
    return { queued: true };
  }
  return { queued: false, inline: true };
}

export type RouteJob = Job<{ orderId: string }>;
export type TrackingJob = Job<{ fulfillmentId: string }>;

export function startWorkers(handlers: {
  route: (orderId: string) => Promise<void>;
  tracking: (fulfillmentId: string) => Promise<void>;
  email?: (emailId: string) => Promise<void>;
}) {
  if (!redisAvailable || !connection) return;
  new Worker(
    QUEUE_ROUTE_FULFILLMENT,
    async (job: RouteJob) => handlers.route(job.data.orderId),
    { connection },
  );
  new Worker(
    QUEUE_TRACKING_POLL,
    async (job: TrackingJob) => handlers.tracking(job.data.fulfillmentId),
    { connection },
  );
  if (handlers.email) {
    const send = handlers.email;
    new Worker(QUEUE_EMAIL_SEND, async (job: Job<{ emailId: string }>) => send(job.data.emailId), { connection });
  }
  console.log('BullMQ workers started');
}
