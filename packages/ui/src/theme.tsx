'use client';
import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { THEME_STORAGE_KEY } from './theme-script';

export type Theme = 'light' | 'dark';

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);
  const set = (t: Theme) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* private mode */ }
    setTheme(t);
  };
  return [theme, set];
}

/** Light/dark switch. Shows the mode you'd switch *to*. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, set] = useTheme();
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="sf-toggle"
      onClick={() => set(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <Icon name={next === 'dark' ? 'dark' : 'light'} size={18} />
      {!compact && <span>{next === 'dark' ? 'Dark' : 'Light'}</span>}
    </button>
  );
}
