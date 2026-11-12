/**
 * Tailwind preset mapping StoreForge role tokens, for any app/theme that adopts Tailwind.
 * (Phase 0/1 apps use plain CSS on the same tokens; both read tokens.css.)
 *   // tailwind.config.ts
 *   import preset from '@storeforge/ui/tailwind.preset';
 *   export default { presets: [preset], content: [...] };
 */
const v = (name: string) => `rgb(var(--sf-${name}) / <alpha-value>)`;

const preset = {
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        primary: v('brand'),
        'on-primary': v('on-brand'),
        accent: v('money'),
        'on-accent': v('on-money'),
        'accent-ink': v('money-ink'),
        secondary: v('alt'),
        'on-secondary': v('on-alt'),
        canvas: v('canvas'),
        surface: v('surface'),
        'surface-2': v('surface-2'),
        ink: v('ink'),
        muted: v('muted'),
        line: v('line'),
        control: v('control'),
        band: v('band'),
        'on-band': v('on-band'),
        rail: v('rail'),
        'on-rail': v('on-rail'),
        success: v('success'),
        warning: v('warning'),
        danger: v('danger'),
        info: v('info'),
      },
      fontFamily: {
        display: ['var(--sf-font-display)'],
        sans: ['var(--sf-font-ui)'],
        mono: ['var(--sf-font-mono)'],
      },
      borderRadius: { sm: 'var(--sf-radius-sm)', DEFAULT: 'var(--sf-radius)', lg: 'var(--sf-radius-lg)' },
      borderWidth: { DEFAULT: 'var(--sf-stroke)' },
    },
  },
};
export default preset;
