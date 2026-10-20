/**
 * Шаблон сообщения клиента ([ADR-0087](../../../docs/adr/0087-konstruktor-soobshcheniya.md)): упорядоченные блоки, из которых
 * собирается итоговый текст. Одна чистая функция для воркера и для предпросмотра в кабинете — показанное и отправленное
 * не расходятся.
 */

import { MESSAGE_MAX_LENGTH } from './messaging.js';

export const TEMPLATE_BLOCK_KINDS = ['greeting', 'text', 'body', 'bot_link'] as const;
export type TemplateBlockKind = (typeof TEMPLATE_BLOCK_KINDS)[number];

/** Когда блок попадает в сообщение: всегда или только в первое этому человеку. */
export const TEMPLATE_WHEN = ['always', 'first'] as const;
export type TemplateWhen = (typeof TEMPLATE_WHEN)[number];

/** Где блок действует: везде, только в сообщениях бота или только в сообщениях через аккаунты партнёров. */
export const TEMPLATE_VIA = ['all', 'bot', 'account'] as const;
export type TemplateVia = (typeof TEMPLATE_VIA)[number];

export const TEMPLATE_BLOCKS_MAX = 12;
export const TEMPLATE_TEXT_MAX = 300;
export const TEMPLATE_GREETING_DEFAULT = 'Здравствуйте, {имя}!';

/** Блок шаблона. `body` — сам текст сообщения (из SMPP, API или формы): ровно один. */
export interface TemplateBlock {
  readonly kind: TemplateBlockKind;
  /** У `greeting` и `text`; у `body` и `bot_link` текста нет. */
  readonly text?: string | undefined;
  /** У `body` всегда `always`. */
  readonly when: TemplateWhen;
  /** Не задано — везде (так хранятся шаблоны, собранные до появления выбора). У `body` всегда везде. */
  readonly via?: TemplateVia | undefined;
}

export interface TemplateContext {
  /** Текст клиента (тело сообщения). */
  readonly body: string;
  /** Имя человека, если он сам сообщил его боту. */
  readonly name: string | null;
  /** Ссылка на бота клиента, если бот подключён. */
  readonly botLink: string | null;
  /** Это первое сообщение клиента этому человеку. */
  readonly first: boolean;
  /** Каким путём уйдёт сообщение. */
  readonly route: 'bot' | 'account';
}

/** Нет имени — убираем `{имя}` вместе с соседней запятой или пробелом: «Здравствуйте, {имя}!» → «Здравствуйте!». */
function withName(text: string, name: string | null): string {
  if (name !== null) return text.replaceAll('{имя}', name);
  return text
    .replace(/\s*,\s*\{имя\}/gu, '')
    .replace(/\{имя\}\s*,\s*/gu, '')
    .replace(/\s*\{имя\}/gu, '')
    .replace(/\{имя\}/gu, '')
    .trim();
}

/**
 * Собирает итоговый текст. Блоки соединяются переводом строки; пустые пропускаются. Не влезло в предел мессенджера —
 * уходит один `body`: чем обрезать, лучше отправить целиком то, что написал клиент.
 */
export function composeMessage(blocks: readonly TemplateBlock[], context: TemplateContext): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind !== 'body') {
      if (block.when === 'first' && !context.first) continue;
      if (block.via !== undefined && block.via !== 'all' && block.via !== context.route) continue;
    }
    let part: string | null;
    switch (block.kind) {
      case 'body':
        part = context.body;
        break;
      case 'bot_link':
        part = context.botLink;
        break;
      case 'greeting':
        part = withName(block.text ?? TEMPLATE_GREETING_DEFAULT, context.name);
        break;
      case 'text':
        part = (block.text ?? '').trim();
        break;
    }
    if (part !== null && part !== '') parts.push(part);
  }
  const composed = parts.join('\n');
  return composed === '' || composed.length > MESSAGE_MAX_LENGTH ? context.body : composed;
}
