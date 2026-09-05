import { useMemo, useRef, useState } from 'react';
import { useAuthedImage, useReducedMotion } from '@app/lib/hooks';

/** Deterministic hue from an id, so an agent always looks like itself. */
function hueFor(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  return hash;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  // One word gives one letter: "NO" for Nova reads as a word, not a monogram.
  if (parts.length === 1) return parts[0]![0]!.toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

/**
 * The lightweight agent likeness used in lists and cards.
 *
 * Deliberately not a Three.js scene: a grid of agents should not spin up a
 * renderer each. Parallax here is a CSS transform, and the heavier portrait is
 * reserved for the single agent in view on its own page.
 */
export function AgentGlyph({
  agentId,
  name,
  imageUrl,
  size = 'md',
  interactive = true,
}: {
  agentId: string;
  name: string;
  imageUrl?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  interactive?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [broken, setBroken] = useState(false);
  const reduced = useReducedMotion();
  const hue = useMemo(() => hueFor(agentId || name), [agentId, name]);
  // A portrait AI17Z stores is behind the authenticated artifact route, which
  // an <img> cannot reach on its own. Resolved here rather than at each of the
  // six call sites, so every place an agent appears gets it without knowing.
  const resolved = useAuthedImage(imageUrl);

  const dimensions = {
    sm: 'h-10 w-10 text-xs',
    md: 'h-16 w-16 text-base',
    lg: 'h-28 w-28 text-2xl',
    xl: 'h-44 w-44 text-4xl sm:h-56 sm:w-56 sm:text-5xl',
  }[size];

  const canTilt = interactive && !reduced;

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!canTilt) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    setTilt({ x: -py * 13, y: px * 13 });
  };

  const showImage = Boolean(resolved) && !broken;

  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={() => setTilt({ x: 0, y: 0 })}
      className={`${dimensions} relative shrink-0 select-none`}
      style={{ perspective: '700px' }}
    >
      <div
        className="relative h-full w-full overflow-hidden rounded-2xl border border-ink-line transition-transform duration-500 ease-stage"
        style={{
          transform: canTilt ? `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)` : undefined,
          transformStyle: 'preserve-3d',
          background: showImage
            ? undefined
            : `radial-gradient(120% 100% at 30% 15%, hsl(${hue} 22% 34%) 0%, hsl(${(hue + 40) % 360} 16% 14%) 55%, #0C0C0C 100%)`,
        }}
      >
        {showImage ? (
          <img
            src={resolved!}
            alt=""
            onError={() => setBroken(true)}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center font-medium tracking-tight text-bone/85">
            {initialsOf(name)}
          </span>
        )}
        {/* Rim light: the single touch that makes the flat form read as a solid. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'linear-gradient(160deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0) 42%, rgba(0,0,0,0.35) 100%)',
          }}
        />
      </div>
    </div>
  );
}
