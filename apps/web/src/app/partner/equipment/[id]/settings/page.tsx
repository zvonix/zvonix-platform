'use client';

import { useMutation } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode, type SubmitEvent } from 'react';
import { ConsoleShell } from '@/components/console-shell';
import { ErrorNote } from '@/components/error-note';
import { LineCredentials, type IssuedLines, type PortAccount } from '@/components/sip-credentials';
import { TariffSelect } from '@/components/tariff-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { integerFromInput } from '@/lib/money';
import { PARTNER_RATES_KEY } from '@/lib/tariffs';
import { EQUIPMENT_KEY, type Gateway } from '../../equipment';
import { asApiError, DeleteGateway, MAX_PORTS, RegistrationMode, useRefresh } from '../../manage';
import { GatewayLoader } from '../gateway-loader';

/**
 * Настройки шлюза — всё, что меняет сам шлюз, в одном месте
 * ([DESIGN.md](../../../../../../../../docs/DESIGN.md), «Страница объекта: что где лежит»):
 * название, модель, число линий, тариф, способ подключения и, отдельно внизу, удаление.
 *
 * Страница, а не окно: смена способа подключения и удаление идут с подтверждением,
 * а окно поверх окна в кабинете запрещено (навык `ui-review`, «Отказы и опасные действия»).
 */
export default function PartnerGatewaySettingsPage() {
  const params = useParams<{ id: string }>();
  return (
    <ConsoleShell title="Настройки шлюза" cabinet="partner">
      {() => (
        <GatewayLoader
          id={params.id}
          back={{ href: `/partner/equipment/${params.id}`, label: 'К шлюзу' }}
        >
          {({ gateway }) => <Settings gateway={gateway} />}
        </GatewayLoader>
      )}
    </ConsoleShell>
  );
}

function Settings({ gateway }: { gateway: Gateway }) {
  const router = useRouter();
  const refresh = useRefresh();
  // Входы новых линий и линий после смены способа подключения — показываются один раз,
  // поэтому живут выше разделов, которые перерисовываются после сохранения.
  const [issued, setIssued] = useState<readonly IssuedLines[]>([]);
  const onIssued = (lines: IssuedLines): void => {
    setIssued((list) => [...list, lines]);
  };
  const goip = gateway.type === 'goip';

  return (
    <>
      <h2 className="text-lg font-semibold">Настройки шлюза «{gateway.name}»</h2>

      {issued.map((secret) => (
        <LineCredentials
          key={secret.lines[0]?.username ?? secret.title}
          lines={secret.lines}
          title={secret.title}
          onClose={() => {
            setIssued((list) => list.filter((item) => item !== secret));
          }}
        />
      ))}

      <DetailsForm gateway={gateway} onIssued={onIssued} />
      <TariffSection gateway={gateway} />

      {goip && (
        // Без своего заголовка: строка «Способ подключения: …» у самого переключателя
        // и так называет раздел, второй заголовок повторял бы её слово в слово.
        <section aria-label="Способ подключения" className="flex max-w-[720px] flex-col gap-2">
          <RegistrationMode gateway={gateway} onIssued={onIssued} />
        </section>
      )}

      <section
        aria-labelledby="danger"
        className="flex max-w-[720px] flex-col gap-2 border-t border-border pt-4"
      >
        <h3 id="danger" className="font-semibold">
          Удаление
        </h3>
        <DeleteGateway
          gateway={gateway}
          onDeleted={() => {
            void refresh();
            router.replace('/partner/equipment');
          }}
        />
      </section>
    </>
  );
}

/** Что ввёл партнёр — строками, как в полях; числа разбираются при проверке. */
interface Draft {
  readonly name: string;
  readonly model: string;
  readonly lines: string;
}

const draftOf = (gateway: Gateway): Draft => ({
  name: gateway.name,
  model: gateway.model ?? '',
  lines: String(gateway.ports.length),
});

/**
 * Название, модель и число линий — одной формой с одной кнопкой «Сохранить».
 *
 * Число линий — число, а не кнопки «добавить» и «убрать» у таблицы
 * ([DESIGN.md](../../../../../../../../docs/DESIGN.md)): больше — заводятся следующие,
 * меньше — удаляются последние, и только пустые. Какие линии появятся или уйдут,
 * видно до сохранения; линии с картами мешают уменьшить — это тоже видно сразу,
 * а не после отказа.
 */
function DetailsForm({
  gateway,
  onIssued,
}: {
  gateway: Gateway;
  onIssued: (issued: IssuedLines) => void;
}) {
  const refresh = useRefresh();
  const ids = useId();
  const [draft, setDraft] = useState<Draft>(() => draftOf(gateway));
  const [saved, setSaved] = useState(false);
  const goip = gateway.type === 'goip';

  const current = draftOf(gateway);
  const name = draft.name.trim();
  const model = draft.model.trim();
  const lines = goip ? integerFromInput(draft.lines) : gateway.ports.length;
  const detailsChanged = name !== current.name || model !== current.model;
  const linesChanged = lines !== undefined && lines !== gateway.ports.length;
  const dirty = detailsChanged || (goip && draft.lines.trim() !== current.lines);

  // Уход со страницы с несохранённым — переспрашивает ([DESIGN.md], «Окно, страница или панель»).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  const nameProblem =
    name.length < 2 ? 'Хотя бы два знака' : name.length > 200 ? 'Не длиннее 200 знаков' : undefined;
  const modelProblem = model.length > 100 ? 'Не длиннее 100 знаков' : undefined;
  const linesProblem =
    lines === undefined || lines > MAX_PORTS
      ? `Целое число от 0 до ${String(MAX_PORTS)}`
      : undefined;
  const blocking =
    lines === undefined
      ? []
      : gateway.ports
          .filter((port) => port.port_number > lines && port.sim !== null)
          .map((port) => port.port_number);

  const save = useMutation({
    mutationFn: async () => {
      if (detailsChanged) {
        await request<unknown>(`/partner/gateways/${gateway.id}/details`, {
          method: 'POST',
          body: { name, model: model === '' ? null : model },
        });
      }
      if (linesChanged) {
        return request<{ port_accounts: PortAccount[] }>(
          `/partner/gateways/${gateway.id}/port-count`,
          { method: 'POST', body: { count: lines } },
        );
      }
      return { port_accounts: [] };
    },
    onSuccess: async (response) => {
      if (response.port_accounts.length > 0) {
        onIssued({ title: `Входы новых линий шлюза «${name}»`, lines: response.port_accounts });
      }
      await refresh();
      setSaved(true);
    },
    onSettled: async () => {
      // Сохранилась часть (название — да, линии — отказ): экран показывает то, что в базе.
      await refresh();
    },
  });
  const error = asApiError(save.error);

  // После сохранения форма берёт значения из ответа: иначе осталась бы «грязной»
  // из-за пробелов, которые сервер обрезал.
  useEffect(() => {
    if (saved) {
      setDraft(draftOf(gateway));
      setSaved(false);
    }
  }, [saved, gateway]);

  const canSave =
    dirty &&
    nameProblem === undefined &&
    modelProblem === undefined &&
    linesProblem === undefined &&
    blocking.length === 0 &&
    !save.isPending;

  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (canSave) save.mutate();
  };

  const set = (field: keyof Draft) => (value: string) => {
    setDraft((previous) => ({ ...previous, [field]: value }));
  };

  return (
    <section aria-labelledby={`${ids}-main`} className="flex max-w-[720px] flex-col gap-3">
      <h3 id={`${ids}-main`} className="font-semibold">
        Шлюз
      </h3>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={onSubmit} noValidate>
        <Field
          id={`${ids}-name`}
          label="Название"
          problem={draft.name === '' ? undefined : nameProblem}
        >
          <Input
            id={`${ids}-name`}
            autoComplete="off"
            value={draft.name}
            aria-invalid={nameProblem !== undefined}
            onChange={(event) => {
              set('name')(event.target.value);
            }}
          />
        </Field>
        <Field id={`${ids}-model`} label="Модель" hint="Необязательно" problem={modelProblem}>
          <Input
            id={`${ids}-model`}
            autoComplete="off"
            value={draft.model}
            placeholder="например, GoIP-8"
            onChange={(event) => {
              set('model')(event.target.value);
            }}
          />
        </Field>
        {goip && (
          <Field
            id={`${ids}-lines`}
            label="Число линий"
            hint={linesHint(gateway.ports.length, lines)}
            problem={
              linesProblem ??
              (blocking.length > 0
                ? `Сначала выньте карты из линий ${blocking.join(', ')}: линию с картой удалить нельзя`
                : undefined)
            }
          >
            <Input
              id={`${ids}-lines`}
              className="num w-28"
              inputMode="numeric"
              autoComplete="off"
              value={draft.lines}
              aria-invalid={linesProblem !== undefined || blocking.length > 0}
              onChange={(event) => {
                set('lines')(event.target.value);
              }}
            />
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={!canSave}>
            {save.isPending ? 'Сохраняем…' : 'Сохранить'}
          </Button>
          {!dirty && save.isSuccess && (
            <span role="status" className="text-ok">
              Сохранено
            </span>
          )}
          {dirty && !save.isPending && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(current);
                save.reset();
              }}
            >
              Отменить изменения
            </Button>
          )}
        </div>
        {error !== undefined && <ErrorNote error={error} className="sm:col-span-2" />}
      </form>
    </section>
  );
}

/** Что произойдёт с линиями — словами, до сохранения. */
function linesHint(now: number, target: number | undefined): string {
  if (target === undefined || target === now || target > MAX_PORTS) {
    return `Сейчас ${String(now)}: столько, сколько слотов под SIM на корпусе`;
  }
  if (target > now) {
    return target - now === 1
      ? `Добавится линия ${String(target)}`
      : `Добавятся линии ${String(now + 1)}–${String(target)}`;
  }
  return now - target === 1
    ? `Удалится линия ${String(now)}`
    : `Удалятся линии ${String(target + 1)}–${String(now)}`;
}

function Field({
  id,
  label,
  hint,
  problem,
  children,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  problem?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      {children}
      {problem !== undefined ? (
        <p className="text-warn">{problem}</p>
      ) : (
        hint !== undefined && <p className="text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** Тариф шлюза — для всех его карт без своего (ADR-0056). Сохраняется сразу при выборе. */
function TariffSection({ gateway }: { gateway: Gateway }) {
  return (
    <section aria-labelledby="tariff" className="flex max-w-[720px] flex-col gap-2">
      <h3 id="tariff" className="font-semibold">
        Тариф
      </h3>
      <p className="text-muted-foreground">
        Для всех карт шлюза без своего тарифа; сохраняется сразу при выборе. Цены — в разделе{' '}
        <Link href="/partner/prices">«Тарифы»</Link>.
      </p>
      <TariffSelect
        value={gateway.tariff_id}
        inheritedId={null}
        inheritedFrom="тариф по умолчанию"
        kind={gateway.type === 'sip_trunk' ? 'sip' : 'sim'}
        endpoint={`/partner/gateways/${gateway.id}/tariff`}
        label={`Тариф шлюза «${gateway.name}»`}
        invalidate={[EQUIPMENT_KEY, PARTNER_RATES_KEY]}
      />
    </section>
  );
}
