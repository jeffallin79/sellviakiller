import type { ReactNode } from 'react';
import { Icon, type IconName } from '@storeforge/ui/icons';

export function PageHead({ eyebrow, icon, title, lede, actions }: { eyebrow: string; icon?: IconName; title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="pagehead">
      <div>
        <p className="sf-eyebrow">{icon && <Icon name={icon} size={16} />}{eyebrow}</p>
        <h1>{title}</h1>
        {lede && <p className="pagehead__lede">{lede}</p>}
      </div>
      {actions && <div className="sf-row">{actions}</div>}
    </header>
  );
}
