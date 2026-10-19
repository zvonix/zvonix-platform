'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiError, request } from '@/lib/api';
import {
  TEMPLATE_BLOCKS_MAX,
  TEMPLATE_GREETING_DEFAULT,
  TEMPLATE_TEXT_MAX,
  composeMessage,
  type TemplateBlock,
  type TemplateWhen,
} from '@zvonix/shared';

/** Блок с ключом: ключ нужен только списку на экране, чтобы поле не «прыгало» при перестановке. */
interface Row extends TemplateBlock {
  readonly key: number;
}

const KEY = ['client', 'messages', 'template'] as const;

const KIND_NAME: Record<TemplateBlock['kind'], string> = {
  greeting: 'Приветствие',
  text: 'Свой текст',
  body: 'Текст сообщения',
  bot_link: 'Ссылка на бота',
};

const SAMPLE_BODY = 'Ваша машина прибыла';

let nextKey = 1;
const rowOf = (block: TemplateBlock): Row => ({ ...block, key: nextKey++ });
const blockOf = ({ key: _key, ...block }: Row): TemplateBlock => block;

/**
 * Конструктор сообщения клиента ([ADR-0087](../../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)): блоки в нужном
 * порядке, у каждого — «всегда» или «только первое сообщение». Под списком — как выглядит сообщение первому и
 * последующим получателям; предпросмотр собирает та же функция, что и отправка.
 */
export function TemplateBuilder() {
  const queryClient = useQueryClient();
  const template = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) =>
      request<{ blocks: TemplateBlock[] }>('/client/messages/template', { signal }),
  });
  const bot = useQuery({
    queryKey: ['client', 'messages', 'bot'],
    queryFn: ({ signal }) =>
      request<{ connection: { link: string } | null }>('/client/messages/bot', { signal }),
  });
  // `null` — правок ещё нет: показывается сохранённое.
  const [draft, setDraft] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (blocks: TemplateBlock[]) =>
      request<{ blocks: TemplateBlock[] }>('/client/messages/template', {
        method: 'PUT',
        body: { blocks },
      }),
    onSuccess: (answer) => {
      queryClient.setQueryData(KEY, answer);
      setDraft(null);
      setSaved(true);
    },
  });

  if (template.data === undefined) return <p className="text-muted-foreground">Загружаем…</p>;

  const rows = draft ?? template.data.blocks.map(rowOf);
  const change = (next: Row[]): void => {
    setDraft(next);
    setSaved(false);
  };
  const patch = (key: number, part: Partial<TemplateBlock>): void => {
    change(rows.map((row) => (row.key === key ? { ...row, ...part } : row)));
  };
  const move = (index: number, by: -1 | 1): void => {
    const next = [...rows];
    const [taken] = next.splice(index, 1);
    if (taken === undefined) return;
    next.splice(index + by, 0, taken);
    change(next);
  };
  const add = (block: TemplateBlock): void => {
    change([...rows, rowOf(block)]);
  };

  const blocks = rows.map(blockOf);
  const link = bot.data?.connection?.link ?? 'https://max.ru/ваш_бот?start=код';
  const preview = (first: boolean): string =>
    composeMessage(blocks, { body: SAMPLE_BODY, name: 'Иван', botLink: link, first });
  const full = rows.length >= TEMPLATE_BLOCKS_MAX;
  const empty = rows.some(
    (row) => (row.kind === 'greeting' || row.kind === 'text') && (row.text ?? '').trim() === '',
  );
  const error = save.error instanceof ApiError ? save.error : undefined;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Текст сообщения</h2>
        <Hint label="Как собирается сообщение">
          <p>
            Блоки склеиваются сверху вниз. «Текст сообщения» — то, что вы отправляете из формы, SMPP
            или API. В приветствии {'{имя}'} заменяется именем человека, если он назвал его боту,
            иначе пропадает.
          </p>
          <p className="mt-2">
            «Только первое» — блок идёт лишь в первом сообщении этому человеку. Ссылка на бота
            пропускается, если бот не подключён.
          </p>
        </Hint>
      </div>

      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center"
          >
            <span className="w-36 shrink-0 font-medium">{KIND_NAME[row.kind]}</span>
            <div className="min-w-0 flex-1">
              {row.kind === 'greeting' || row.kind === 'text' ? (
                <Input
                  aria-label={KIND_NAME[row.kind]}
                  value={row.text ?? ''}
                  maxLength={TEMPLATE_TEXT_MAX}
                  placeholder={
                    row.kind === 'greeting' ? TEMPLATE_GREETING_DEFAULT : 'Например: Такси Волна'
                  }
                  onChange={(event) => {
                    patch(row.key, { text: event.target.value });
                  }}
                />
              ) : (
                <span className="text-muted-foreground">
                  {row.kind === 'body' ? SAMPLE_BODY : link}
                </span>
              )}
            </div>
            {row.kind !== 'body' && (
              <select
                aria-label={`Когда: ${KIND_NAME[row.kind]}`}
                value={row.when}
                onChange={(event) => {
                  patch(row.key, { when: event.target.value as TemplateWhen });
                }}
                className="h-9 rounded-md border border-input bg-transparent px-2"
              >
                <option value="always">Всегда</option>
                <option value="first">Только первое</option>
              </select>
            )}
            <div className="flex shrink-0 gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Выше"
                disabled={index === 0}
                onClick={() => {
                  move(index, -1);
                }}
              >
                <ArrowUp size={16} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Ниже"
                disabled={index === rows.length - 1}
                onClick={() => {
                  move(index, 1);
                }}
              >
                <ArrowDown size={16} aria-hidden />
              </Button>
              {row.kind !== 'body' && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Удалить: ${KIND_NAME[row.kind]}`}
                  onClick={() => {
                    change(rows.filter((other) => other.key !== row.key));
                  }}
                >
                  <Trash2 size={16} aria-hidden />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ['Приветствие', { kind: 'greeting', text: TEMPLATE_GREETING_DEFAULT, when: 'always' }],
            ['Свой текст', { kind: 'text', text: '', when: 'always' }],
            ['Ссылка на бота', { kind: 'bot_link', when: 'always' }],
          ] as const
        ).map(([label, block]) => (
          <Button
            key={label}
            type="button"
            variant="outline"
            size="sm"
            disabled={full}
            onClick={() => {
              add(block);
            }}
          >
            <Plus size={14} aria-hidden /> {label}
          </Button>
        ))}
      </div>

      <section aria-label="Как это выглядит" className="flex flex-col gap-2">
        <h3 className="font-semibold">Как это выглядит</h3>
        {([true, false] as const).map((first) => (
          <div key={String(first)} className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {first ? 'Первое сообщение человеку' : 'Следующие сообщения'}
            </span>
            <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-sans">
              {preview(first)}
            </pre>
          </div>
        ))}
      </section>

      {error !== undefined && <ErrorNote error={error} />}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={draft === null || empty || save.isPending}
          onClick={() => {
            save.mutate(blocks);
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        {saved && (
          <span role="status" className="text-ok">
            Сохранено
          </span>
        )}
        {empty && <span className="text-warn">Заполните пустые блоки или удалите их</span>}
      </div>
    </div>
  );
}
