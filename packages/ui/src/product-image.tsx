'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';

/**
 * Product photo with a branded paper-cut fallback when the image is missing or fails
 * to load (supplier CDNs do go down). Fills its parent box.
 */
export function ProductImage({ src, alt, className = '', eager = false }: { src?: string | null; alt: string; className?: string; eager?: boolean }) {
  const [failed, setFailed] = useState(!src);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setFailed(!src);
    // Catch errors that fired before hydration attached onError.
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && src) setFailed(true);
  }, [src]);
  if (failed) {
    const initials = alt.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    return (
      <div className={`sf-photo-fallback ${className}`.trim()} role="img" aria-label={alt}>
        <span className="sf-photo-fallback__cut" aria-hidden="true" />
        <span className="sf-photo-fallback__txt" aria-hidden="true">{initials || <Icon name="package" size={28} />}</span>
      </div>
    );
  }
  return <img ref={ref} src={src!} alt={alt} className={className} loading={eager ? 'eager' : 'lazy'} onError={() => setFailed(true)} />;
}
