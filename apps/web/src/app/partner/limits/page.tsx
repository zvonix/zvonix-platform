'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ChevronsDownUp, ChevronsUpDown, Pencil } from 'lucide-react';
import { Hint } from '@/components/hint';
import { HintText, StatusDot } from '@/components/status-dot';
import { HEAD, NUM, ROW_ICON, RowActions, TABLE_FRAME, WIDE_ONLY } from '@/components/table-parts';
import { WithTooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  amount,
  ChangeLimit,
  counted,
  RemoveLimit,
  usePartnerLimits,
  type LimitRow,
  type PartnerLimits as Limits,
} from '@/lib/limits';
import { momentInZone } from '@/lib/format';
import { LIMIT_WINDOW_NAME, limitRuleNote } from '@/lib/labels';

export default function PartnerLimitsPage() {
  return (
    <ConsoleShell title="Лимиты" cabinet="partner">
      {() => <PartnerLimits />}
    </ConsoleShell>
  );
}

/**
 * Остатки лимитов звонков ([ADR-0080](../../../../../../docs/adr/0080-edinye-limity-i-raspredelenie.md)):
 * лимиты заводятся в тарифе и действуют на каждую его карту, здесь видно, сколько осталось и когда
 * обнулится. Прежние лимиты (на все карты вместе, на одну карту) читаются и снимаются здесь же,
 * пока их не перенесли в тарифы.
 */
function PartnerLimits() {
  const limits = usePartnerLimits();

  if (limits.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {limits.error.message}
      </p>
    );
  }
  if (limits.isPending) return <p className="text-muted-foreground">Загружаем…</p>;

  const { sims, tariffs } = limits.data;
  const numberOf = (id: string | null) =>
    id === null ? undefined : sims.find((sim) => sim.id === id)?.msisdn;
  const tariffName = (id: string | null) =>
    id === null ? undefined : tariffs.find((tariff) => tariff.id === id)?.name;
  // Строки одного правила — подряд, чтобы правило и его действия стояли один раз.
  const groups = groupById(limits.data.limits);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="outline">
          <Link href="/partner/prices">Изменить в тарифах</Link>
        </Button>
        <Hint label="Как работают лимиты звонков">
          <p>
            Лимит звонков задаётся в тарифе и действует на каждую карту, которая работает по этому
            тарифу. Исчерпавшая лимит карта отдыхает до обнуления, остальные продолжают работать.
          </p>
        </Hint>
      </div>

      <div className={TABLE_FRAME}>
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className={HEAD}>Лимит</TableHead>
              <TableHead className={HEAD}>Карты</TableHead>
              <TableHead className={`${HEAD} text-right ${WIDE_ONLY}`}>Израсходовано</TableHead>
              <TableHead className={`${HEAD} text-right`}>Осталось</TableHead>
              <TableHead className={`${HEAD} ${WIDE_ONLY}`}>Обнулится</TableHead>
              <TableHead className={`${HEAD} w-px`}>
                <span className="sr-only">Действия</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="whitespace-normal text-muted-foreground">
                  Лимитов нет. Добавьте лимит в тарифе — он начнёт действовать на его картах.
                </TableCell>
              </TableRow>
            )}
            {groups.map((rows) => (
              <LimitGroup
                key={rows[0]?.id ?? ''}
                rows={rows}
                numberOf={numberOf}
                tariffName={tariffName}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * Правило с цифрами по картам. Пока карт немного, строки видны сразу — как и было; у правила на сотни карт
 * строк становится на сотни, поэтому такое правило свёрнуто в одну строку: сколько карт, сколько исчерпало
 * лимит и сколько осталось у самой «бедной». Раскрытое показывает исчерпавшие первыми.
 */
const COLLAPSE_FROM = 6;

function LimitGroup({
  rows,
  numberOf,
  tariffName,
}: {
  rows: LimitRow[];
  numberOf: (id: string | null) => string | undefined;
  tariffName: (id: string | null) => string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const first = rows[0];
  if (first === undefined) return null;

  const collapsible = rows.length >= COLLAPSE_FROM;
  const collapsed = collapsible && !open;
  const exhausted = rows.filter((row) => row.exceeded).length;
  const poorest = Math.min(...rows.map((row) => row.limit - row.used));
  // Исчерпавшие — первыми: в раскрытом списке сначала то, что требует внимания.
  const visible = collapsed
    ? []
    : collapsible
      ? [...rows].sort((a, b) => Number(b.exceeded) - Number(a.exceeded))
      : rows;

  // Правило — одной строкой; чей это тариф или как считается — в подсказке (DESIGN.md, «Таблица»).
  const note =
    first.tariff_id === null
      ? limitRuleNote(first)
      : `тариф «${tariffName(first.tariff_id) ?? '—'}»`;
  const ruleText = `${counted(first.metric, first.value)} ${LIMIT_WINDOW_NAME[first.window]}`;
  const rule =
    note === '' ? (
      <span className="whitespace-nowrap">{ruleText}</span>
    ) : (
      <HintText label={ruleText} reason={note} />
    );

  if (collapsed) {
    return (
      <TableRow>
        <TableCell>
          <span className="inline-flex items-center gap-1">
            {rule}
            <Toggle
              label="Показать все"
              onClick={() => {
                setOpen(true);
              }}
            />
          </span>
        </TableCell>
        <TableCell>
          <span className="inline-flex items-center gap-2">
            <span className="num">{rows.length} карт</span>
            {exhausted > 0 && (
              <StatusDot
                tone="crit"
                label={`исчерпали: ${String(exhausted)}`}
                reason="эти карты отдыхают до обнуления лимита"
              />
            )}
          </span>
        </TableCell>
        <TableCell className={WIDE_ONLY} />
        <TableCell className={NUM}>
          {poorest <= 0 ? (
            <Exhausted />
          ) : (
            <HintText
              label={amount(first.metric, poorest)}
              reason="меньше всего осталось у одной из карт правила"
            />
          )}
        </TableCell>
        <TableCell className={WIDE_ONLY} />
        <TableCell>
          <Actions row={first} />
        </TableCell>
      </TableRow>
    );
  }

  return (
    <Fragment>
      {visible.map((row, index) => (
        <TableRow key={`${row.id}:${row.usage_sim_card_id ?? ''}`}>
          {index === 0 && (
            <TableCell rowSpan={visible.length} className="align-top">
              <span className="inline-flex items-center gap-1">
                {rule}
                {collapsible && (
                  <Toggle
                    label="Свернуть"
                    onClick={() => {
                      setOpen(false);
                    }}
                  />
                )}
              </span>
            </TableCell>
          )}
          <TableCell className="num">
            {whose(row, numberOf) ?? <span className="text-faint">—</span>}
          </TableCell>
          <TableCell className={`${NUM} ${WIDE_ONLY} ${row.exceeded ? 'text-crit' : ''}`}>
            {amount(row.metric, row.used)}
          </TableCell>
          <TableCell className={NUM}>
            {row.exceeded ? <Exhausted /> : amount(row.metric, row.limit - row.used)}
          </TableCell>
          <TableCell className={`num text-muted-foreground ${WIDE_ONLY}`}>
            {momentInZone(row.resets_at, row.timezone)}
          </TableCell>
          {index === 0 && (
            <TableCell rowSpan={visible.length} className="align-top">
              <Actions row={row} />
            </TableCell>
          )}
        </TableRow>
      ))}
    </Fragment>
  );
}

/** Исчерпанный лимит — точкой, что это значит — в подсказке. */
function Exhausted() {
  return <StatusDot tone="crit" label="исчерпан" reason="карта отдыхает до обнуления лимита" />;
}

/** Свернуть и развернуть правило на много карт — значком рядом с правилом: строка остаётся в одну линию. */
function Toggle({ label, onClick }: { label: 'Показать все' | 'Свернуть'; onClick: () => void }) {
  const Icon = label === 'Свернуть' ? ChevronsDownUp : ChevronsUpDown;
  return (
    <WithTooltip label={label}>
      <Button type="button" {...ROW_ICON} aria-label={label} onClick={onClick}>
        <Icon aria-hidden className="size-4" />
      </Button>
    </WithTooltip>
  );
}

/** Что можно сделать с правилом отсюда: лимит тарифа меняется в тарифе, лимит площадки — только площадкой. */
function Actions({ row }: { row: LimitRow }) {
  if (row.tariff_id !== null) {
    return (
      <RowActions>
        <WithTooltip label="Меняется в тарифе">
          <Button asChild {...ROW_ICON}>
            <Link href="/partner/prices" aria-label="Меняется в тарифе">
              <Pencil aria-hidden className="size-4" />
            </Link>
          </Button>
        </WithTooltip>
      </RowActions>
    );
  }
  if (row.set_by !== 'partner') {
    return <span className="whitespace-nowrap text-muted-foreground">задала площадка</span>;
  }
  return (
    <RowActions>
      <ChangeLimit row={row} />
      <RemoveLimit row={row} />
    </RowActions>
  );
}

/** Строки по правилу, в порядке первого появления: одно правило — одна группа. */
function groupById(rows: Limits['limits']): LimitRow[][] {
  const groups = new Map<string, LimitRow[]>();
  for (const row of rows) {
    const group = groups.get(row.id);
    if (group === undefined) groups.set(row.id, [row]);
    else group.push(row);
  }
  return [...groups.values()];
}

/** Чьи карты считает строка: все вместе, каждая (номер строки) или одна. */
function whose(
  row: LimitRow,
  numberOf: (id: string | null) => string | undefined,
): string | undefined {
  if (row.per_sim) return numberOf(row.usage_sim_card_id);
  if (row.sim_card_id !== null) return numberOf(row.sim_card_id);
  return 'все вместе';
}
