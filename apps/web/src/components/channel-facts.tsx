'use client';

import { StatusDot } from '@/components/status-dot';
import {
  channelConnection,
  channelEnabled,
  channelLastCall,
  type ChannelFact,
  type ChannelStateInput,
  type ChannelViewer,
} from '@/lib/channel-state';

/**
 * Три сведения о линии клиента — «Включена», «Подключение», «Последний вызов» — ячейками таблицы и строками страницы
 * линии. Одни на кабинет клиента и админку: расчёт в `lib/channel-state.ts`, здесь только вид
 * ([ADR-0101](../../../../docs/adr/0101-liniya-klienta-podklyuchenie-i-samoobsluzhivanie.md), дополнение
 * от 2026-11-19).
 */

/** Ячейка «Включена»: на узком экране — точка, слово в подсказке (DESIGN.md, «Таблица», «Телефон»). */
export function ChannelEnabledCell({
  channel,
  viewer,
}: {
  channel: ChannelStateInput;
  viewer: ChannelViewer;
}) {
  return <FactDot fact={channelEnabled(channel, viewer)} />;
}

/** Ячейка «Подключение». */
export function ChannelConnectionCell({
  channel,
  viewer,
}: {
  channel: ChannelStateInput;
  viewer: ChannelViewer;
}) {
  return <FactDot fact={channelConnection(channel, viewer)} />;
}

/** Ячейка «Последний вызов»: прочерк бледнее даты — «звонков не было» не требует внимания. */
export function ChannelLastCallCell({ channel }: { channel: ChannelStateInput }) {
  const text = channelLastCall(channel);
  return text === '—' ? (
    <span className="text-faint">—</span>
  ) : (
    <span className="num whitespace-nowrap">{text}</span>
  );
}

/**
 * Слово видно с 1024: на 768 с открытым меню рядом не помещаются «Выключена площадкой» и «Есть, с адреса …», и
 * таблица уезжала вбок. Уже — точки, слово и пояснение в подсказке.
 */
function FactDot({ fact }: { fact: ChannelFact }) {
  return (
    <StatusDot tone={fact.tone} label={fact.label} reason={fact.reason} phoneDot labelFrom="lg" />
  );
}

/**
 * Те же три сведения строками — в шапке страницы линии. Места там хватает, поэтому пояснение («Введите в программе
 * логин и пароль этой линии») написано рядом, а не спрятано в подсказку. У «Да» и «Есть» пояснять нечего.
 */
export function ChannelFacts({
  channel,
  viewer,
}: {
  channel: ChannelStateInput;
  viewer: ChannelViewer;
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1">
      <FactRow name="Включена" fact={channelEnabled(channel, viewer)} />
      <FactRow name="Подключение" fact={channelConnection(channel, viewer)} />
      <dt className="text-muted-foreground">Последний вызов</dt>
      <dd>
        <ChannelLastCallCell channel={channel} />
      </dd>
    </dl>
  );
}

function FactRow({ name, fact }: { name: string; fact: ChannelFact }) {
  return (
    <>
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <StatusDot tone={fact.tone} label={fact.label} />
        {fact.tone !== 'ok' && fact.reason !== undefined && (
          <span className="text-muted-foreground">{fact.reason}</span>
        )}
      </dd>
    </>
  );
}
