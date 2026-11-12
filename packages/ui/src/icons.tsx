/**
 * StoreForge icon set: Phosphor Icons (MIT), duotone weight only, so every icon in the
 * product shares one style. The duotone layer is filled saffron via `.sf-icon--duo`
 * (base.css); the stroke uses currentColor (garnet in content, mist on the ink rail).
 * SSR build so it works in server and client components alike.
 */
import type { ComponentType, SVGProps } from 'react';
import {
  RocketLaunch, Books, Truck, Megaphone, GasPump, Storefront, Receipt, Bank, SignOut, Sun, Moon,
  CheckCircle, Circle, ArrowRight, ArrowLeft, ShoppingBag, Plus, Minus, Clock, MapPin, ShieldCheck,
  DownloadSimple, ArrowsClockwise, Trash, Warning, Info, X, Package, Coins, Sparkle, Tote, Seal, ListChecks, Wallet,
} from '@phosphor-icons/react/dist/ssr';

export const icons = {
  launchpad: RocketLaunch,
  shelf: Books,
  dispatch: Truck,
  boost: Megaphone,
  fuel: GasPump,
  stores: Storefront,
  billing: Receipt,
  payouts: Bank,
  wallet: Wallet,
  signOut: SignOut,
  light: Sun,
  dark: Moon,
  done: CheckCircle,
  todo: Circle,
  next: ArrowRight,
  back: ArrowLeft,
  cart: ShoppingBag,
  bag: Tote,
  add: Plus,
  remove: Minus,
  eta: Clock,
  origin: MapPin,
  secure: ShieldCheck,
  export: DownloadSimple,
  sync: ArrowsClockwise,
  trash: Trash,
  warning: Warning,
  info: Info,
  close: X,
  package: Package,
  money: Coins,
  spark: Sparkle,
  seal: Seal,
  tasks: ListChecks,
} as const;

export type IconName = keyof typeof icons;

type PhosphorLike = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string; weight?: string }>;

export function Icon({
  name,
  size = 20,
  label,
  className = '',
}: {
  name: IconName;
  size?: number;
  /** Accessible label. Omit for decorative icons (then aria-hidden). */
  label?: string;
  className?: string;
}) {
  const C = icons[name] as unknown as PhosphorLike;
  return (
    <C
      size={size}
      weight="duotone"
      className={`sf-icon sf-icon--duo ${className}`.trim()}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    />
  );
}
