const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};
/** Blueprint: reminders at 1 h and 24 h after the shopper's last activity. */
export const cartConfig = () => ({
  reminder1Ms: num(process.env.CART_REMINDER_1_MINUTES, 60) * 60_000,
  reminder2Ms: num(process.env.CART_REMINDER_2_HOURS, 24) * 3_600_000,
  /** Reminder 2 never goes out sooner than this after reminder 1 (e.g. after downtime) */
  minGapMs: 12 * 3_600_000,
  /** Carts idle longer than this get no first reminder (stale) */
  firstReminderWindowMs: 72 * 3_600_000,
  expireMs: num(process.env.CART_EXPIRE_DAYS, 7) * 86_400_000,
  /** One reminder sequence per address per store in this window, however many carts */
  perAddressWindowMs: 7 * 86_400_000,
});
