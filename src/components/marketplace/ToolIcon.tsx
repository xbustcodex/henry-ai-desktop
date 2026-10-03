/**
 * An icon that resolves itself, with a text fallback.
 *
 * Used by the Marketplace cards so a tool shows a recognisable mark instead of
 * a blank square. The chain lives in utils/toolIcons; this only handles the
 * failure case, which is the part that has to be right — a listing whose icon
 * 404s should look like a listing without an icon, never like a broken image.
 */
import { useEffect, useState } from 'react';
import { resolveToolIcon, nextIconInChain } from '../../utils/toolIcons';

const SIZES = { sm: 16, md: 20, lg: 28 } as const;

export default function ToolIcon({
  name,
  size = 'md',
  className = '',
}: {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const px = SIZES[size];
  const [src, setSrc] = useState<string | null>(() => resolveToolIcon(name));
  const [tried, setTried] = useState<string[]>([]);

  // A different listing gets a different chain.
  useEffect(() => {
    setSrc(resolveToolIcon(name));
    setTried([]);
  }, [name]);

  if (!src) {
    return (
      <span
        aria-hidden
        className={`inline-flex items-center justify-center rounded-md bg-henry-surface text-henry-text-muted font-semibold shrink-0 ${className}`}
        style={{ width: px, height: px, fontSize: Math.round(px * 0.55) }}
      >
        {(name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden
      loading="lazy"
      className={`shrink-0 object-contain ${className}`}
      style={{ width: px, height: px }}
      onError={() => {
        // Walk the fallback chain, then give up quietly and show the letter.
        const next = nextIconInChain(name, [...tried, src]);
        if (next) {
          setTried((t) => [...t, src]);
          setSrc(next);
        } else {
          setSrc(null);
        }
      }}
    />
  );
}