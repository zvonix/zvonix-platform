'use client';

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';

/** Поле вокруг кода в модулях: меньше четырёх сканеры читают хуже (стандарт QR). */
const QUIET_ZONE = 4;

/**
 * Модули QR-кода как одна фигура: `M x y h1 v1 h-1 z` на каждый тёмный модуль. Уровень исправления ошибок «M»:
 * ссылка читается, даже если наклейка потёрта или кое-где закрыта.
 */
function modulesOf(value: string): { path: string; size: number } {
  const code = qrcode(0, 'M');
  code.addData(value);
  code.make();
  const count = code.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (code.isDark(row, col))
        path += `M${String(col + QUIET_ZONE)} ${String(row + QUIET_ZONE)}h1v1h-1z`;
    }
  }
  return { path, size: count + QUIET_ZONE * 2 };
}

/** SVG-файл кода: чёрные модули на белом, для печати. */
function svgFile(value: string): string {
  const { path, size } = modulesOf(value);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}" width="512" height="512" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>\n`;
}

/**
 * QR-код ссылки ([ADR-0077](../../../../docs/adr/0077-bot-max-vtoroy-kanal.md)): службе — распечатать или показать
 * пассажиру, чтобы открыть бота камерой, не набирая ссылку. Рисуется всегда чёрным на белом, в любой теме: на тёмном
 * фоне инвертированный код сканеры не читают.
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const code = useMemo(() => modulesOf(value), [value]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([svgFile(value)], { type: 'image/svg+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'qr-bot-max.svg';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${String(code.size)} ${String(code.size)}`}
        className="size-32 shrink-0 rounded-md border border-border bg-white"
        shapeRendering="crispEdges"
      >
        <path d={code.path} fill="#000" />
      </svg>
      <Button variant="outline" size="sm" onClick={download}>
        Скачать QR
      </Button>
    </div>
  );
}
