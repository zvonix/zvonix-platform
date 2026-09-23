'use client';

import type { ReactNode } from 'react';
import { ThemeSwitch } from '@/components/theme-switch';

/**
 * Каркас страниц без входа, куда ведут ссылки из писем: подтверждение адреса,
 * восстановление пароля. Тот же вид, что у страницы входа, — человек пришёл из письма
 * и должен узнать площадку, а не гадать, не подделка ли это.
 */
export function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-[380px]">
        <div className="flex items-baseline pb-4">
          <span className="text-[17px] font-semibold tracking-tight">Zvonix</span>
          <span className="ml-auto">
            <ThemeSwitch />
          </span>
        </div>
        <main className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <h1 className="text-base font-semibold">{title}</h1>
          {children}
        </main>
      </div>
    </div>
  );
}
