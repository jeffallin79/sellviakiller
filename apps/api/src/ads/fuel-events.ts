import { EventEmitter } from 'node:events';

/**
 * In-process signals between the money code (payments module) and Boost (ads module) without a
 * DI cycle. Handlers must be idempotent; they're also re-run by the scheduler.
 *   added  – fuel was credited (top-up / auto-reload)  → settle shortfalls, resume low-fuel pauses
 *   empty  – a charge couldn't be fully covered         → pause fuel-funded campaigns
 */
export const fuelEvents = new EventEmitter();
fuelEvents.setMaxListeners(20);
