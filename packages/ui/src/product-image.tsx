'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

/**
 * Product photo over a branded paper-cut fallback. The fallback is always painted underneath;
 * the photo fades in only once it has really loaded, so a slow, missing or broken image
 * (supplier CDNs do go down) shows the cut-out instead of a blank box. Fills its parent.
 */
export function ProductImage({ src, alt, className = '', eager = false }: { src?: string | null; alt: string; className?: string; eager?: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>(src ? 'loading' : 'failed');
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!src) return setState('failed');
    const img = ref.current;
    // Events can fire before hydration attaches handlers.
    if (img?.complete) setState(img.naturalWidth > 0 ? 'loaded' : 'failed');
    else setState('loading');
  }, [src]);
  const initials = alt.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span className={`sf-photo sf-photo--${state} ${className}`.trim()} role="img" aria-label={alt}>
      <span className="sf-photo-fallback" aria-hidden="true">
        <span className="sf-photo-fallback__cut" />
        <span className="sf-photo-fallback__txt">{initials || <Icon name="package" size={28} />}</span>
      </span>
      {src && state !== 'failed' && (
        <img
          ref={ref}
          src={src}
          alt=""
          aria-hidden="true"
          loading={eager ? 'eager' : 'lazy'}
          onLoad={(e) => setState(e.currentTarget.naturalWidth > 0 ? 'loaded' : 'failed')}
          onError={() => setState('failed')}
        />
      )}
    </span>
  );
}
