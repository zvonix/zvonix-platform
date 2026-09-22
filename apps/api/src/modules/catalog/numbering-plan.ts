/**
 * План нумерации: файл источника и его разбор
 * ([ADR-0032](../../../../../docs/adr/0032-zagruzka-plana-numeracii.md)).
 *
 * Разбор отделён от скачивания, как и у определения оператора: разбор проверяется
 * на настоящем куске файла без сети, а источник заменяется без правки разбора.
 */

import { Inject, Injectable } from '@nestjs/common';
import { dependencyUnavailable } from '@zvonix/shared';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '../../infra/tokens.js';

/** Строка плана: кому выделен диапазон. */
export interface PlanRange {
  /** Три цифры после кода страны. */
  readonly defCode: string;
  /** Границы в том же виде, что и номер: `79000000000`. */
  readonly rangeStart: bigint;
  readonly rangeEnd: bigint;
  readonly capacity: number;
  /** Название оператора так, как его написал источник. Приведением занимается вызывающий. */
  readonly operatorName: string;
  readonly inn: string | null;
  readonly region: string | null;
}

export interface ParsedPlan {
  readonly ranges: readonly PlanRange[];
  /** Сколько строк отброшено как неразобранные. Ноль ожидаем, рост — признак смены формата. */
  readonly skipped: number;
}

/**
 * Признаки заголовка файла Минцифры.
 *
 * Проверяются до разбора: источник отдаёт страницу с ошибкой тем же кодом 200,
 * и без этой проверки она разобралась бы в пустой план, а пустой план стёр бы настоящий.
 */
const HEADER_MARKERS = ['DEF', 'Емкость', 'ИНН'] as const;

/** Колонок в строке. Их ровно восемь, проверено на всех 17 060 строках файла. */
const COLUMNS = 8;

const DEF_DIGITS = 3;
const SUFFIX_DIGITS = 7;

/**
 * Разбирает выгрузку плана нумерации Минцифры.
 *
 * Формат (проверен на файле `DEF-9xx.csv` 2026-09-03): UTF-8 с BOM, разделитель `;`,
 * колонки `АВС/ DEF;От;До;Емкость;Оператор;Регион;Территория ГАР;ИНН`.
 *
 * Регион берётся из «Территория ГАР», а не из «Регион»: во втором у 1 661 строки
 * стоит прочерк, а в первом значение есть всегда.
 */
export function parseNumberingPlan(text: string): ParsedPlan {
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const header = lines[0] ?? '';

  if (!HEADER_MARKERS.every((marker) => header.includes(marker))) {
    throw dependencyUnavailable('Файл плана нумерации не похож на выгрузку источника', {
      details: { head: header.slice(0, 120) },
    });
  }

  const ranges: PlanRange[] = [];
  let skipped = 0;

  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;

    const parsed = parseRow(line);
    if (parsed === undefined) skipped += 1;
    else ranges.push(parsed);
  }

  return { ranges, skipped };
}

function parseRow(line: string): PlanRange | undefined {
  const cells = line.split(';');
  if (cells.length !== COLUMNS) return undefined;

  const [def, from, to, capacity, operatorName, , territory, inn] = cells;
  if (def === undefined || from === undefined || to === undefined) return undefined;
  if (operatorName === undefined || territory === undefined) return undefined;

  if (!isDigits(def, DEF_DIGITS)) return undefined;
  if (!isDigits(from, SUFFIX_DIGITS) || !isDigits(to, SUFFIX_DIGITS)) return undefined;

  const rangeStart = BigInt(`7${def}${from}`);
  const rangeEnd = BigInt(`7${def}${to}`);
  if (rangeEnd < rangeStart) return undefined;

  const name = operatorName.trim();
  if (name === '') return undefined;

  // Ёмкость в файле всегда совпадает с шириной диапазона — проверено на всех строках.
  // Считаем её сами: расхождение означало бы, что разобрано не то, а не что источник
  // сообщил дополнительный факт.
  const width = Number(rangeEnd - rangeStart) + 1;
  if (capacity !== undefined && capacity.trim() !== '' && Number(capacity) !== width) {
    return undefined;
  }

  return {
    defCode: def,
    rangeStart,
    rangeEnd,
    capacity: width,
    operatorName: name,
    inn: normalizeCell(inn),
    region: normalizeCell(territory),
  };
}

function isDigits(value: string, length: number): boolean {
  return value.length === length && /^\d+$/u.test(value);
}

/** Прочерк в выгрузке означает «не заполнено», а не значение. */
function normalizeCell(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

/**
 * Откуда берётся файл плана нумерации.
 *
 * Отделено интерфейсом: проверки кормят разбор готовым куском файла и в сеть не ходят.
 */
export interface NumberingPlanFile {
  /** `undefined` — источник выключен или недоступен. */
  download(): Promise<string | undefined>;
  readonly enabled: boolean;
}

export const NUMBERING_PLAN_FILE = Symbol('NUMBERING_PLAN_FILE');

/**
 * Предел времени на скачивание.
 *
 * Файл — три мегабайта, и качается он фоновой задачей, а не в цепочке вызова: спешить
 * некуда, но и висеть до утра нельзя — следующий проход не начнётся, пока не кончился
 * этот.
 */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * Ограничение на размер ответа.
 *
 * Файл вырос втрое — это не файл. Читаем в память целиком: три мегабайта дешевле,
 * чем потоковый разбор с частичным состоянием, а вот безразмерный ответ в память
 * класть нельзя.
 */
const MAX_BYTES = 32 * 1024 * 1024;

@Injectable()
export class MincifryPlanFile implements NumberingPlanFile {
  private readonly logger: Logger;

  constructor(
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('numbering-plan');
  }

  get enabled(): boolean {
    return this.config.NUMBERING_PLAN_ENABLED;
  }

  async download(): Promise<string | undefined> {
    if (!this.enabled) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(this.config.NUMBERING_PLAN_URL, {
        signal: controller.signal,
        headers: {
          // Источник отвечает 403 на запрос без User-Agent и на `curl/*`, но принимает
          // честное название платформы (проверено 2026-09-03). Притворяться браузером
          // не нужно и не надо: подделка перестанет работать, как только источник
          // начнёт различать клиентов, а мы об этом узнаем последними.
          'user-agent': `${this.config.APP_NAME}/1.0 (+${this.config.PUBLIC_BASE_URL})`,
          accept: 'text/csv,*/*',
        },
      });

      if (!response.ok) {
        this.logger.error('Источник плана нумерации ответил отказом', undefined, {
          status: response.status,
        });
        return undefined;
      }

      const body = await response.arrayBuffer();
      if (body.byteLength > MAX_BYTES) {
        this.logger.error('Файл плана нумерации неправдоподобно велик', undefined, {
          bytes: body.byteLength,
          limit: MAX_BYTES,
        });
        return undefined;
      }

      return new TextDecoder('utf-8').decode(body);
    } catch (cause) {
      this.logger.error('Файл плана нумерации не скачан', cause, {
        url: this.config.NUMBERING_PLAN_URL,
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
