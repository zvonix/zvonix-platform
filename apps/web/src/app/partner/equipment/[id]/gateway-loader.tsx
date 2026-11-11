'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { request } from '@/lib/api';
import { EQUIPMENT_KEY, type Equipment, type Gateway } from '../equipment';

/**
 * Общая загрузка трёх страниц шлюза — самой страницы, настроек и подключения.
 *
 * Отдельного обработчика нет: шлюз берётся из того же ответа `GET /partner/equipment`,
 * что и список, — без портов и свободных карт он не значит ничего, а свободные карты
 * нужны, чтобы вставить их в линию. Три страницы на одном ключе запроса: изменение
 * на одной видно на другой без перезагрузки.
 */
export function GatewayLoader({
  id,
  back,
  children,
}: {
  id: string;
  /** Куда ведёт ссылка «назад» и как она подписана. */
  back: { href: string; label: string };
  children: (loaded: { gateway: Gateway; equipment: Equipment }) => ReactNode;
}) {
  const equipment = useQuery({
    queryKey: EQUIPMENT_KEY,
    queryFn: () => request<Equipment>('/partner/equipment'),
  });

  const backLink = <BackLink href={back.href} label={back.label} />;
  if (equipment.isPending) return <p className="text-muted-foreground">Загружаем…</p>;
  if (equipment.data === undefined) {
    return (
      <div className="flex flex-col gap-3">
        {backLink}
        <p role="alert" className="text-crit">
          {equipment.error.message}
        </p>
      </div>
    );
  }

  const gateway = equipment.data.gateways.find((row) => row.id === id);
  if (gateway === undefined) {
    return (
      <div className="flex flex-col gap-3">
        <BackLink href="/partner/equipment" label="Всё оборудование" />
        <p>Такого шлюза нет — возможно, он удалён. Остальное оборудование — в общем списке.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {backLink}
      {children({ gateway, equipment: equipment.data })}
    </div>
  );
}

/** Название устройства в подписях: «Подключение GOIP», а у телефона — устройство. */
export function connectLabel(gateway: Gateway): string {
  return gateway.type === 'goip' ? 'Подключение GOIP' : 'Подключение устройства';
}

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="self-start text-primary underline-offset-4 hover:underline">
      ← {label}
    </Link>
  );
}
