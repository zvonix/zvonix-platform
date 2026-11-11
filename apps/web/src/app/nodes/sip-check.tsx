'use client';

import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';

/**
 * Проверка адреса SIP узла — как её отдаёт `GET /nodes/:id/sip-check`
 * ([ADR-0113](../../../../../docs/adr/0113-adres-sip-uzla-sam-i-bez-podmeny.md), ревизия).
 */
export interface SipCheck {
  readonly verdict:
    'ok' | 'mismatch' | 'missing' | 'ip' | 'ip_mismatch' | 'none' | 'unverifiable' | 'error';
  readonly address: string | null;
  readonly resolved: readonly string[];
  readonly expected: readonly string[];
  readonly record: {
    readonly name: string;
    readonly type: 'A' | 'AAAA';
    readonly value: string;
  } | null;
}

/** Короткая отметка для строки списка: видно, что не так, не открывая окна. */
export function SipCheckBadge({ check }: { check: SipCheck | null }) {
  if (check === null) return null;
  const [tone, text] = BADGE[check.verdict];
  return <span className={`block ${tone}`}>{text}</span>;
}

const BADGE: Record<SipCheck['verdict'], readonly [string, string]> = {
  ok: ['text-ok', '✓ DNS верно'],
  mismatch: ['text-crit', '✗ запись ведёт не туда'],
  missing: ['text-crit', '✗ записи DNS нет'],
  ip: ['text-muted-foreground', 'IP — лучше имя'],
  ip_mismatch: ['text-crit', '✗ не адрес узла'],
  none: ['text-warn', 'адрес не задан'],
  unverifiable: ['text-muted-foreground', 'проверить не с чем'],
  error: ['text-warn', 'DNS не ответил'],
};

/**
 * Что показала проверка — словами, и что сделать, если не так.
 *
 * Запись, которую нужно завести, — полем в поле, как в панели регистратора: тип, имя, значение,
 * каждое с копированием. Имя предлагается от домена сайта и вставляется в адрес одной кнопкой
 * (владелец, 2026-11-11: «должно быть всё логично, красиво и удобно»).
 */
export function SipCheckReport({
  check,
  checking,
  onRecheck,
  onUseName,
}: {
  check: SipCheck | undefined;
  checking: boolean;
  onRecheck: () => void;
  onUseName: (name: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3 sm:col-span-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Проверка DNS</span>
        <Button type="button" size="xs" variant="ghost" disabled={checking} onClick={onRecheck}>
          {checking ? 'Проверяем…' : 'Проверить снова'}
        </Button>
      </div>
      {check === undefined ? (
        <p className="text-muted-foreground">
          {checking ? 'Спрашиваем DNS…' : 'Проверка не удалась'}
        </p>
      ) : (
        <>
          <Verdict check={check} />
          {check.record !== null && check.verdict !== 'ok' && (
            <RecordToCreate
              record={check.record}
              // Имя уже вписано — вставлять нечего; предлагается, только если вписан IP или ничего.
              onUseName={check.address === check.record.name ? undefined : onUseName}
            />
          )}
        </>
      )}
    </div>
  );
}

function Verdict({ check }: { check: SipCheck }) {
  const node = check.expected.join(', ');
  const resolved = check.resolved.join(', ');
  switch (check.verdict) {
    case 'ok':
      return (
        <p className="text-ok">
          ✓ <span className="num">{check.address}</span> ведёт на{' '}
          <span className="num">{resolved}</span> — это адрес узла. Всё верно: этот адрес партнёры
          вписывают в GOIP.
        </p>
      );
    case 'mismatch':
      return (
        <p className="text-crit">
          ✗ <span className="num">{check.address}</span> ведёт на{' '}
          <span className="num">{resolved}</span>, а узел стоит на{' '}
          <span className="num">{node}</span>. GOIP партнёров уйдут не туда — исправьте запись у
          регистратора домена.
        </p>
      );
    case 'missing':
      return (
        <p className="text-crit">
          ✗ Записи <span className="num">{check.address}</span> в DNS нет — GOIP не найдут узел.
          Заведите её у регистратора домена:
        </p>
      );
    case 'ip':
      return (
        <p className="text-muted-foreground">
          Указан IP узла — работать будет. Но лучше имя: переедет узел — поменяется одна запись DNS,
          а не настройки каждой линии у каждого партнёра.
        </p>
      );
    case 'ip_mismatch':
      return (
        <p className="text-crit">
          ✗ <span className="num">{check.address}</span> — не адрес узла: узел обращается к площадке
          с <span className="num">{node}</span>.
        </p>
      );
    case 'none':
      return (
        <p className="text-warn">
          Адрес не задан — GOIP партнёров подключать некуда. Заведите запись и впишите имя:
        </p>
      );
    case 'unverifiable':
      return (
        <p className="text-muted-foreground">
          Сравнить не с чем: узел ещё не обращался к площадке или стоит за NAT с частным адресом.
          {resolved !== '' && (
            <>
              {' '}
              Имя сейчас ведёт на <span className="num">{resolved}</span>.
            </>
          )}
        </p>
      );
    case 'error':
      return <p className="text-warn">DNS не ответил вовремя — проверьте ещё раз через минуту.</p>;
  }
}

function RecordToCreate({
  record,
  onUseName,
}: {
  record: NonNullable<SipCheck['record']>;
  onUseName: ((name: string) => void) | undefined;
}) {
  const label = record.name.split('.')[0] ?? record.name;
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Тип</dt>
        <dd className="num">{record.type}</dd>
        <dt className="text-muted-foreground">Имя</dt>
        <dd className="flex items-center gap-1">
          <span className="num select-all">{label}</span>
          <span className="text-muted-foreground">
            (полностью — <span className="num">{record.name}</span>)
          </span>
          <CopyButton value={label} label="Скопировать имя записи" />
        </dd>
        <dt className="text-muted-foreground">Значение</dt>
        <dd className="flex items-center gap-1">
          <span className="num select-all">{record.value}</span>
          <CopyButton value={record.value} label="Скопировать значение записи" />
        </dd>
      </dl>
      {onUseName !== undefined && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onUseName(record.name);
            }}
          >
            Вписать {record.name} в адрес
          </Button>
        </div>
      )}
    </div>
  );
}
