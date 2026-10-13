'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Появление блока при прокрутке.
 *
 * Без скриптов и при `prefers-reduced-motion` блок виден сразу: скрывается он только здесь, после
 * монтирования, и только если браузер умеет `IntersectionObserver`. Страница не должна оставаться
 * пустой из-за того, что сценарий не отработал.
 */
export function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Задержка появления, мс: блоки ряда выходят друг за другом. */
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!('IntersectionObserver' in window)) return;

    element.dataset['reveal'] = 'pending';
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          element.dataset['reveal'] = 'shown';
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={delay > 0 ? { transitionDelay: `${String(delay)}ms` } : undefined}
    >
      {children}
    </div>
  );
}
