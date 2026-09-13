'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { request } from './api';

/**
 * Справочники, которые нужны нескольким экранам сразу.
 *
 * Списки операторов и клиентов не меняются от экрана к экрану, а по идентификатору
 * человеку показывать нечего: в тарифе лежит `operator_id`, а видеть надо «МегаФон».
 * Ключ запроса общий, поэтому раскрытая карточка партнёра и страница тарифов делят
 * один ответ, а не спрашивают его каждая.
 */

const FRESH_FOR = 5 * 60 * 1000;

/**
 * Строка справочника. Наружу не выносится: потребитель берёт её из `Dictionary`,
 * а отдельное имя означало бы второй способ сказать то же самое.
 */
interface NamedRow {
  readonly id: string;
  readonly name: string;
  /**
   * Кому запись принадлежит: канал — клиенту, SIM — партнёру.
   *
   * Нужен там, где выбор двухступенчатый («сначала клиент, потом его канал») и где
   * одноимённые записи разных владельцев иначе неразличимы: «Диспетчерская» есть
   * у половины клиентов. У справочников без владельца поля просто нет.
   */
  readonly ownerId?: string;
}

export interface Dictionary {
  readonly rows: readonly NamedRow[];
  /** Имя по идентификатору либо `undefined`, если запись не пришла. */
  readonly nameOf: (id: string) => string | undefined;
  readonly error: Error | null;
}

function toDictionary(query: UseQueryResult<readonly NamedRow[]>): Dictionary {
  const rows = query.data ?? [];
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return { rows, nameOf: (id) => byId.get(id), error: query.error };
}

/** Операторы связи. Справочник целиком: их десятки, а не тысячи. */
export function useOperators(enabled = true): Dictionary {
  return toDictionary(
    useQuery({
      queryKey: ['operators'],
      queryFn: async () =>
        (await request<{ operators: NamedRow[] }>('/operators')).operators as readonly NamedRow[],
      staleTime: FRESH_FOR,
      enabled,
    }),
  );
}

/**
 * Клиенты — для правил наценки, где правило может быть привязано к одному клиенту.
 *
 * Страница выбрана большой намеренно: это список для выпадающего меню, и разбивать
 * его на страницы там негде. Когда клиентов станет больше двухсот, понадобится
 * поиск по мере ввода — тогда и появится, а до тех пор лишний механизм.
 */
export function useClients(enabled = true): Dictionary {
  return toDictionary(
    useQuery({
      queryKey: ['clients', 'dictionary'],
      queryFn: async () =>
        (await request<{ clients: NamedRow[] }>('/clients?limit=200'))
          .clients as readonly NamedRow[],
      staleTime: FRESH_FOR,
      enabled,
    }),
  );
}

/**
 * Партнёры — для отбора вызовов по тому, через кого они ушли.
 *
 * Настоящее имя, а не псевдоним: справочник спрашивается из административного
 * контура, где имя партнёра видно ([ADR-0014](../../../../docs/adr/0014-vybor-partnera-klientom.md)).
 */
export function usePartners(enabled = true): Dictionary {
  return toDictionary(
    useQuery({
      queryKey: ['partners', 'dictionary'],
      queryFn: async () =>
        (await request<{ partners: NamedRow[] }>('/partners?limit=200'))
          .partners as readonly NamedRow[],
      staleTime: FRESH_FOR,
      enabled,
    }),
  );
}

/**
 * Каналы клиентов — целиком, всех клиентов сразу.
 *
 * Владелец у строки заполнен: по нему список сужается до выбранного клиента там,
 * где выбирают канал, и по нему же различаются одноимённые каналы разных клиентов.
 */
export function useChannels(enabled = true): Dictionary {
  return toDictionary(
    useQuery({
      queryKey: ['channels', 'dictionary'],
      queryFn: async () => {
        const response = await request<{
          channels: { id: string; name: string; client_id: string }[];
        }>('/channels');
        return response.channels.map((row) => ({
          id: row.id,
          name: row.name,
          ownerId: row.client_id,
        }));
      },
      staleTime: FRESH_FOR,
      enabled,
    }),
  );
}

/**
 * SIM партнёров. Названием служит номер: другого имени у SIM нет.
 *
 * **Только административный контур**: номер SIM в клиентский не попадает никогда
 * ([ADR-0014](../../../../docs/adr/0014-vybor-partnera-klientom.md)) — по нему клиент
 * вышел бы на партнёра напрямую в обход платформы.
 */
export function useSimCards(enabled = true): Dictionary {
  return toDictionary(
    useQuery({
      queryKey: ['sim-cards', 'dictionary'],
      queryFn: async () => {
        const response = await request<{
          sim_cards: { id: string; msisdn: string; partner_id: string }[];
        }>('/sim-cards');
        return response.sim_cards.map((row) => ({
          id: row.id,
          name: row.msisdn,
          ownerId: row.partner_id,
        }));
      },
      staleTime: FRESH_FOR,
      enabled,
    }),
  );
}
