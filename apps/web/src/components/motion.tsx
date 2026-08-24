import { motion, useScroll, useSpring, useTransform, type MotionValue } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useReducedMotion } from '@app/lib/hooks';

const EASE = [0.16, 1, 0.3, 1] as const;

/** Reveals a block once when it enters the viewport. Static when motion is reduced. */
export function FadeIn({
  children,
  delay = 0,
  y = 28,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-12% 0px -8% 0px' }}
      transition={{ duration: 0.75, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Word-by-word reveal for monumental headings. */
export function AnimatedText({
  text,
  className,
  delay = 0,
  as: Tag = 'h2',
}: {
  text: string;
  className?: string;
  delay?: number;
  as?: 'h1' | 'h2' | 'h3' | 'p';
}) {
  const reduced = useReducedMotion();
  const words = text.split(' ');
  if (reduced) return <Tag className={className}>{text}</Tag>;
  return (
    <Tag className={className}>
      {words.map((word, index) => (
        <motion.span
          key={`${word}-${index}`}
          className="inline-block"
          initial={{ opacity: 0, y: '0.35em' }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
          transition={{ duration: 0.7, delay: delay + index * 0.055, ease: EASE }}
        >
          {word}
          {index < words.length - 1 ? '\u00A0' : ''}
        </motion.span>
      ))}
    </Tag>
  );
}

/** Subtle pull toward the pointer. Pointer-fine devices only. */
export function MagneticElement({
  children,
  strength = 14,
  className,
}: {
  children: ReactNode;
  strength?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const node = ref.current;
    if (!node) return;
    if (!window.matchMedia('(pointer: fine)').matches) return;

    const onMove = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);
      const radius = Math.max(rect.width, rect.height) * 1.1;
      if (distance > radius) {
        setOffset({ x: 0, y: 0 });
        return;
      }
      const pull = 1 - distance / radius;
      setOffset({ x: (dx / radius) * strength * pull * 2, y: (dy / radius) * strength * pull * 2 });
    };
    const onLeave = () => setOffset({ x: 0, y: 0 });

    window.addEventListener('pointermove', onMove, { passive: true });
    node.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
    };
  }, [strength, reduced]);

  return (
    <motion.div
      ref={ref}
      className={className}
      animate={{ x: offset.x, y: offset.y }}
      transition={{ type: 'spring', stiffness: 180, damping: 18, mass: 0.5 }}
    >
      {children}
    </motion.div>
  );
}

/** Thin progress bar tied to page scroll. */
export function ScrollProgress() {
  const { scrollYProgress } = useScroll();
  const width = useSpring(scrollYProgress, { stiffness: 120, damping: 30, restDelta: 0.001 });
  return (
    <motion.div
      aria-hidden
      className="fixed inset-x-0 top-0 z-50 h-px origin-left bg-signal-calm/70"
      style={{ scaleX: width }}
    />
  );
}

/** Cards that stack and settle as the page scrolls past them. */
export function StickyStackItem({
  index,
  total,
  children,
}: {
  index: number;
  total: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.85', 'start 0.25'] });
  const scale: MotionValue<number> = useTransform(scrollYProgress, [0, 1], [0.965, 1]);
  const opacity: MotionValue<number> = useTransform(scrollYProgress, [0, 1], [0.45, 1]);

  if (reduced) {
    return (
      <div ref={ref} className="mb-4">
        {children}
      </div>
    );
  }
  return (
    <motion.div
      ref={ref}
      className="sticky"
      style={{
        scale,
        opacity,
        top: `calc(6rem + ${index * 0.75}rem)`,
        zIndex: index + 1,
        marginBottom: index === total - 1 ? 0 : '1.25rem',
      }}
    >
      {children}
    </motion.div>
  );
}
