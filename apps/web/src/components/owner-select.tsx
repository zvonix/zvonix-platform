'use client';

import { useQuery } from '@tanstack/react-query';
import { request } from '@/lib/api';

interface OwnerCandidate {
  readonly id: string;
  readonly email: string;
  readonly full_name: string;
}

/**
 * Выбор учётной записи владельца — общий для клиента и партнёра.
 *
 * Берутся только участники рынка (роль `member`) **с открытым входом**: сотрудник
 * площадки владельцем карточки не бывает, и API такой выбор отвергнет
 * ([ADR-0052](../../../../docs/adr/0052-odin-vkhod-dva-kabineta.md)). Открытый вход — потому что пароль человек задаёт
 * себе сам при регистрации, и заводить учётную запись за него значило бы придумывать
 * чужой пароль. Записи в состоянии «ждёт допуска» здесь нет намеренно — сначала её
 * допускают в разделе «Учётные записи».
 *
 * Страница выбрана большой: это выпадающий список, разбивать его на страницы негде.
 * Когда записей станет больше двухсот, понадобится поиск по мере ввода — тогда
 * и появится, а до тех пор лишний механизм.
 */
export function OwnerSelect({
  value,
  onChange,
  enabled = true,
}: {
  value: string;
  onChange: (id: string) => void;
  enabled?: boolean;
}) {
  const owners = useQuery({
    queryKey: ['users', 'owners'],
    queryFn: () =>
      request<{ users: OwnerCandidate[] }>('/users?role=member&status=active&limit=200'),
    enabled,
  });

  const candidates = owners.data?.users ?? [];

  return (
    // На обе колонки окна заведения: в строке «имя — адрес» полторы сотни знаков.
    <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
      <label className="flex flex-col gap-1">
        <span className="font-medium">Учётная запись владельца</span>
        <select
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2"
        >
          <option value="">выберите запись</option>
          {candidates.map((user) => (
            <option key={user.id} value={user.id}>
              {user.full_name} — {user.email}
            </option>
          ))}
        </select>
      </label>

      {owners.data !== undefined && candidates.length === 0 && (
        <span className="text-xs text-warn">
          Нет учётных записей с этой ролью и открытым входом. Сначала человек регистрируется сам,
          затем его допускают в разделе «Учётные записи».
        </span>
      )}

      {owners.error !== null && (
        <span role="alert" className="text-crit">
          {owners.error.message}
        </span>
      )}
    </div>
  );
}
