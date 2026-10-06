'use client';

import { Rows3, Rows4 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { applyDensity, DENSITY_STORAGE_KEY, isDensity, type Density } from '@/lib/density';

/**
 * Переключатель плотности таблиц: обычная или плотная. Одна кнопка с состоянием `aria-pressed`: «плотно»
 * включено или нет. До монтирования рисуется невыбранной — сервер не знает, что лежит в хранилище браузера.
 */
export function DensitySwitch() {
  const [density, setDensity] = useState<Density | undefined>(undefined);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(DENSITY_STORAGE_KEY);
    } catch {
      // Приватное окно: плотность не запоминается, остаётся обычная.
    }
    setDensity(isDensity(stored) ? stored : 'normal');
  }, []);

  function toggle(): void {
    const next: Density = density === 'compact' ? 'normal' : 'compact';
    setDensity(next);
    applyDensity(next);
    try {
      localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // Выбор действует до перезагрузки страницы.
    }
  }

  const compact = density === 'compact';
  const Icon = compact ? Rows4 : Rows3;
  return (
    <button
      type="button"
      aria-pressed={compact}
      aria-label="Плотные таблицы"
      title={compact ? 'Таблицы: плотно' : 'Таблицы: обычно'}
      onClick={toggle}
      className={`hidden min-h-8 min-w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted md:flex ${
        compact ? 'bg-muted text-foreground' : 'text-muted-foreground'
      }`}
    >
      <Icon size={14} strokeWidth={2} aria-hidden />
    </button>
  );
}
