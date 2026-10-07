'use client';

import {
  SMPP_RECEIPT_ACTIONS,
  SMPP_RECEIPT_EVENTS,
  type SmppReceiptAction,
  type SmppReceiptEvent,
  type SmppReceiptMap,
} from '@zvonix/shared';
import { useState } from 'react';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';

/** Подписи событий и ответов: «ответ» — то, что наша площадка пришлёт программе клиента по SMPP. */
const EVENT_LABEL: Record<SmppReceiptEvent, string> = {
  sent: 'Сообщение ушло в MAX',
  delivered: 'MAX доставил сообщение',
  read: 'Получатель прочитал',
};

const ACTION_LABEL: Record<SmppReceiptAction, string> = {
  none: 'Ничего не отвечать',
  accepted: 'Ответить «принято» (ACCEPTD)',
  delivered: 'Ответить «доставлено» (DELIVRD)',
};

/** Готовые наборы: лишь заполняют три выбора, сохраняется то, что в них стоит. */
const PRESETS: readonly { readonly name: string; readonly map: SmppReceiptMap }[] = [
  { name: 'Как сейчас', map: { sent: 'none', delivered: 'delivered', read: 'delivered' } },
  { name: 'Сразу, как ушло', map: { sent: 'delivered', delivered: 'none', read: 'none' } },
  { name: 'Только прочитанные', map: { sent: 'none', delivered: 'none', read: 'delivered' } },
  {
    name: 'Принято, затем доставлено',
    map: { sent: 'accepted', delivered: 'delivered', read: 'delivered' },
  },
];

const same = (a: SmppReceiptMap, b: SmppReceiptMap): boolean =>
  SMPP_RECEIPT_EVENTS.every((event) => a[event] === b[event]);

/**
 * Какие ответы SMPP получает программа клиента ([ADR-0076](../../../../../../docs/adr/0076-statusy-smpp-po-nastrojkam-klienta.md)).
 * Если сообщение не дошло, отказ присылается всегда: за него возвращены деньги.
 */
export function SmppReceipts({
  saved,
  saving,
  onSave,
}: {
  readonly saved: SmppReceiptMap;
  readonly saving: boolean;
  readonly onSave: (map: SmppReceiptMap) => void;
}) {
  const [draft, setDraft] = useState<SmppReceiptMap | undefined>(undefined);
  const shown = draft ?? saved;
  const changed = draft !== undefined && !same(draft, saved);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!changed || saving) return;
        onSave(shown);
        setDraft(undefined);
      }}
    >
      <div className="flex items-center gap-1">
        <h3 className="font-medium">Ответы вашей программе</h3>
        <Hint label="Как работают ответы">
          <p>
            На каждое событие выберите, что площадка пришлёт по SMPP. «Принято» — состояние ACCEPTD,
            «доставлено» — DELIVRD. Один и тот же ответ по сообщению приходит один раз.
          </p>
          <p className="mt-2">
            Если сообщение не дошло (у номера нет MAX, не отправилось), отказ приходит всегда, а
            деньги возвращаются. Если вы выбрали «доставлено» сразу при отправке, отказ придёт уже
            после него.
          </p>
        </Hint>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Готовые наборы">
        {PRESETS.map((preset) => (
          <Button
            key={preset.name}
            type="button"
            size="sm"
            variant={same(shown, preset.map) ? 'default' : 'outline'}
            onClick={() => {
              setDraft(preset.map);
            }}
          >
            {preset.name}
          </Button>
        ))}
      </div>

      <div className="grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
        {SMPP_RECEIPT_EVENTS.map((event) => (
          <label key={event} className="contents">
            <span className="text-muted-foreground">{EVENT_LABEL[event]}</span>
            <select
              value={shown[event]}
              onChange={(change) => {
                setDraft({ ...shown, [event]: change.target.value as SmppReceiptAction });
              }}
              className="h-9 rounded-md border border-input bg-transparent px-2"
            >
              {SMPP_RECEIPT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABEL[action]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div>
        <Button type="submit" variant="outline" disabled={!changed || saving}>
          Применить ответы
        </Button>
      </div>
    </form>
  );
}
