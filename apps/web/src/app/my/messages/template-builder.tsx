'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { Hint } from '@/components/hint';
import { BotStartCard } from './bot-start-card';
import { Button } from '@/components/ui/button';
import { ApiError, request } from '@/lib/api';
import {
  MESSAGE_MAX_LENGTH,
  TEMPLATE_BLOCKS_MAX,
  TEMPLATE_GREETING_DEFAULT,
  TEMPLATE_TEXT_MAX,
  composeMessage,
  type TemplateBlock,
  type TemplateVia,
  type TemplateWhen,
  STOP_LINE,
} from '@zvonix/shared';

/** Блок с ключом: ключ нужен только списку на экране, чтобы поле не «прыгало» при перестановке. */
interface Row extends TemplateBlock {
  readonly key: number;
}

interface TemplateAnswer {
  readonly blocks: TemplateBlock[];
  /** Название компании клиента: им подставляется `{название}` в предпросмотре. */
  readonly company: string;
}

const KEY = ['client', 'messages', 'template'] as const;

const KIND_NAME: Record<TemplateBlock['kind'], string> = {
  greeting: 'Приветствие',
  text: 'Свой текст',
  body: 'Текст сообщения',
  bot_link: 'Ссылка на бота',
  break: 'Пустая строка',
};

const SAMPLE_BODY = 'Ваша машина прибыла';

let nextKey = 1;
const rowOf = (block: TemplateBlock): Row => ({ ...block, key: nextKey++ });
const blockOf = ({ key: _key, ...block }: Row): TemplateBlock => block;

const hasText = (kind: TemplateBlock['kind']): boolean => kind === 'greeting' || kind === 'text';

/**
 * Конструктор сообщения клиента ([ADR-0087](../../../../../../docs/adr/0087-konstruktor-soobshcheniya.md)): блоки в нужном
 * порядке; у каждого — «всегда» или «только первое сообщение» и «везде», «только бот» или «только аккаунты». Под списком —
 * как выглядит сообщение на каждом пути; предпросмотр собирает та же функция, что и отправка.
 */
export function TemplateBuilder() {
  const queryClient = useQueryClient();
  const template = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => request<TemplateAnswer>('/client/messages/template', { signal }),
  });
  const bot = useQuery({
    queryKey: ['client', 'messages', 'bot'],
    queryFn: ({ signal }) =>
      request<{ connection: { link: string; kind: 'platform' | 'own'; enabled: boolean } | null }>(
        '/client/messages/bot',
        { signal },
      ),
  });
  // `null` — правок ещё нет: показывается сохранённое.
  const [draft, setDraft] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState(false);

  // Закрыли вкладку или обновили страницу с несохранёнными правками — браузер переспросит.
  const dirty = draft !== null;
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  const save = useMutation({
    mutationFn: (blocks: TemplateBlock[]) =>
      request<TemplateAnswer>('/client/messages/template', {
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
  const company = template.data.company;
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
  const duplicate = (index: number): void => {
    const source = rows[index];
    if (source === undefined) return;
    const next = [...rows];
    next.splice(index + 1, 0, rowOf(blockOf(source)));
    change(next);
  };

  const blocks = rows.map(blockOf);
  const connection = bot.data?.connection ?? null;
  // Бот не подключён — ссылки в сообщении не будет: предпросмотр показывает то, что действительно уйдёт.
  const link = connection?.enabled === true ? connection.link : null;
  const botName =
    connection === null || !connection.enabled
      ? 'бот не подключён — ссылки в сообщении не будет'
      : connection.kind === 'own'
        ? 'ваш бот'
        : 'бот площадки';
  // Через аккаунты имя человека неизвестно, поэтому приветствие там без него.
  const preview = (route: 'bot' | 'account', first: boolean): string =>
    composeMessage(blocks, {
      body: SAMPLE_BODY,
      name: route === 'bot' ? 'Иван' : null,
      company,
      botLink: link,
      first,
      route,
    });
  const full = rows.length >= TEMPLATE_BLOCKS_MAX;
  const isEmpty = (row: Row): boolean => hasText(row.kind) && (row.text ?? '').trim() === '';
  const empty = rows.some(isEmpty);
  const error = save.error instanceof ApiError ? save.error : undefined;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Текст сообщения</h2>
        <Hint label="Как собирается сообщение">
          <p>
            Блоки склеиваются сверху вниз. «Текст сообщения» — то, что вы отправляете из формы, SMPP
            или API. В тексте можно писать {'{имя}'} — имя человека (если он назвал его боту, иначе
            пропадает) и {'{название}'} — название вашей компании.
          </p>
          <p className="mt-2">
            «Только первое» — блок идёт лишь в первом сообщении этому человеку. «Где» — через бота,
            через аккаунты партнёров или везде. Ссылка на бота ведёт на того бота, который подключён
            сейчас, и пропускается, если бот не подключён.
          </p>
        </Hint>
      </div>

      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-start"
          >
            <span className="w-36 shrink-0 pt-1.5 font-medium">{KIND_NAME[row.kind]}</span>
            <div className="min-w-0 flex-1">
              {hasText(row.kind) ? (
                <div className="flex flex-col gap-1">
                  <textarea
                    aria-label={KIND_NAME[row.kind]}
                    aria-invalid={isEmpty(row)}
                    rows={row.kind === 'greeting' ? 1 : 2}
                    value={row.text ?? ''}
                    maxLength={TEMPLATE_TEXT_MAX}
                    placeholder={
                      row.kind === 'greeting' ? TEMPLATE_GREETING_DEFAULT : 'Например: Такси Волна'
                    }
                    onChange={(event) => {
                      patch(row.key, { text: event.target.value });
                    }}
                    className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-1.5 aria-[invalid=true]:border-crit"
                  />
                  <span className="num text-right text-muted-foreground">
                    {String((row.text ?? '').length)} из {String(TEMPLATE_TEXT_MAX)}
                  </span>
                </div>
              ) : (
                <span className="inline-block pt-1.5 text-muted-foreground">
                  {row.kind === 'body'
                    ? SAMPLE_BODY
                    : row.kind === 'bot_link'
                      ? `${link ?? 'ссылки не будет'} (${botName})`
                      : 'пустая строка между частями'}
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
            {row.kind !== 'body' && (
              <select
                aria-label={`Где: ${KIND_NAME[row.kind]}`}
                value={row.via ?? 'all'}
                onChange={(event) => {
                  patch(row.key, { via: event.target.value as TemplateVia });
                }}
                className="h-9 rounded-md border border-input bg-transparent px-2"
              >
                <option value="all">Везде</option>
                <option value="bot">Только бот</option>
                <option value="account">Только аккаунты</option>
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
              {row.kind !== 'body' && row.kind !== 'bot_link' && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Копия: ${KIND_NAME[row.kind]}`}
                  disabled={full}
                  onClick={() => {
                    duplicate(index);
                  }}
                >
                  <Copy size={16} aria-hidden />
                </Button>
              )}
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
            ['Пустая строка', { kind: 'break', when: 'always' }],
            ['Ссылка на бота', { kind: 'bot_link', when: 'always', via: 'account' }],
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
        <span className="num self-center text-muted-foreground">
          {String(rows.length)} из {String(TEMPLATE_BLOCKS_MAX)} блоков
        </span>
      </div>

      <section aria-label="Как это выглядит" className="flex flex-col gap-2">
        <h3 className="font-semibold">Как это выглядит</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ['bot', 'Через бота'],
              ['account', 'Через аккаунты партнёров'],
            ] as const
          ).map(([route, title]) => (
            <div key={route} className="flex flex-col gap-2">
              <span className="flex items-center gap-1 font-medium">
                {title}
                {route === 'account' && (
                  <Hint label="Про строку «СТОП»">
                    <p>
                      Если партнёр включил у своего аккаунта «СТОП», в конце сообщения добавляется
                      строка «{STOP_LINE}». Какой аккаунт отправит, заранее неизвестно, поэтому
                      строка показана серым.
                    </p>
                  </Hint>
                )}
              </span>
              {([true, false] as const).map((first) => {
                const text = preview(route, first);
                return (
                  <div key={String(first)} className="flex flex-col gap-1">
                    <span className="flex justify-between text-muted-foreground">
                      <span>{first ? 'Первое сообщение человеку' : 'Следующие сообщения'}</span>
                      <span className="num">
                        {String(text.length)} из {String(MESSAGE_MAX_LENGTH)}
                      </span>
                    </span>
                    <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 font-sans">
                      {text}
                      {route === 'account' && (
                        <span className="mt-2 block border-t border-dashed border-border pt-2 text-muted-foreground">
                          {STOP_LINE}
                        </span>
                      )}
                    </pre>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </section>

      {error !== undefined && <ErrorNote error={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          disabled={draft === null || empty || save.isPending}
          onClick={() => {
            save.mutate(blocks);
          }}
        >
          {save.isPending ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={draft === null || save.isPending}
          onClick={() => {
            setDraft(null);
            setSaved(false);
          }}
        >
          Сбросить
        </Button>
        {saved && (
          <span role="status" className="text-ok">
            Сохранено
          </span>
        )}
        {empty && <span className="text-warn">Заполните пустые блоки или удалите их</span>}
      </div>
      <BotStartCard company={company} />
    </div>
  );
}
