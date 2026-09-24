import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';

/** Оператор в ответе `GET /operators` для сотрудника площадки. */
export interface Operator {
  readonly id: string;
  readonly name: string;
  readonly inn: string | null;
  readonly mnc: string | null;
  readonly is_mvno: boolean;
  readonly host_operator_id: string | null;
  /** Пусто — запись завёл импорт плана нумерации, человек её не смотрел. */
  readonly verified_at: string | null;
  readonly aliases: readonly string[];
}

/** Справочник целиком — и таблице, и выбору оператора при проверке номера. */
export function useStaffOperators() {
  return useQuery({
    // Под общим `['operators']`: подтверждение записи обновляет и выбор операторов в формах.
    queryKey: ['operators', 'staff'],
    queryFn: () => request<{ operators: Operator[] }>('/operators'),
    select: (data) => data.operators,
  });
}
