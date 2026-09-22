'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { request } from '@/lib/api';
import { useOperators } from '@/lib/dictionaries';
import { money } from '@/lib/money';

interface Violation {
  readonly rate: {
    readonly id: string;
    readonly partner_id: string;
    readonly operator_id: string;
    readonly region: string | null;
    readonly price_per_minute: string;
  };
  readonly band: {
    readonly min_price: string;
    readonly max_price: string;
  };
  readonly reference_cost: string;
  readonly reference_call_seconds: number;
}

/**
 * Действующие цены, оказавшиеся вне действующего коридора.
 *
 * Возникает от **сужения коридора после** назначения цены: строка тарифа неизменяема,
 * и переписывать её значило бы переоценивать прошлое. Без этого списка правило
 * «цена всегда внутри коридора» тихо перестало бы выполняться.
 *
 * Пустой список не показывается вовсе: раздел, который всегда пуст, приучает
 * не смотреть на него, и в тот единственный день, когда он непустой, его не заметят.
 */
export function BandViolations() {
  const operators = useOperators();

  const list = useQuery({
    queryKey: ['price-bands', 'violations'],
    queryFn: () => request<{ violations: Violation[] }>('/price-bands/violations'),
  });

  const violations = list.data?.violations ?? [];

  if (list.error !== null) {
    return (
      <p role="alert" className="text-crit">
        {list.error.message}
      </p>
    );
  }

  if (violations.length === 0) return null;

  const seconds = violations[0]?.reference_call_seconds ?? 60;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold text-crit">Цены вне коридора</h2>
      <p className="text-muted-foreground">
        Коридор сузили после того, как цена была назначена. Строка тарифа неизменяема — чинится
        новой ценой партнёра, а не правкой старой. Сравнивается стоимость вызова в {seconds} секунд.
      </p>

      <div className="max-w-[900px] rounded-md border border-crit-soft bg-card">
        <Table>
          <TableHeader>
            <TableRow className="text-muted-foreground hover:bg-transparent">
              <TableHead className="h-8">Оператор</TableHead>
              <TableHead className="h-8">Регион</TableHead>
              <TableHead className="h-8 text-right">Стоит</TableHead>
              <TableHead className="h-8 text-right">Коридор</TableHead>
              <TableHead className="h-8">Партнёр</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {violations.map((violation) => (
              <TableRow key={violation.rate.id}>
                <TableCell>
                  {operators.nameOf(violation.rate.operator_id) ?? (
                    <span className="num text-faint">{violation.rate.operator_id}</span>
                  )}
                </TableCell>
                <TableCell>
                  {violation.rate.region ?? <span className="text-muted-foreground">все</span>}
                </TableCell>
                <TableCell className="num text-right text-crit">
                  {money(violation.reference_cost)}
                </TableCell>
                <TableCell className="num text-right text-muted-foreground">
                  {money(violation.band.min_price)} — {money(violation.band.max_price)}
                </TableCell>
                <TableCell>
                  {/*
                    Идентификатор, а не имя: список партнёров сюда не тянется ради
                    одной колонки, а по идентификатору партнёр находится поиском
                    в своём разделе. Имя добавится, когда список нужно будет и здесь.
                  */}
                  <span className="num text-faint">{violation.rate.partner_id}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
