#!/usr/bin/env bash
# Ежедневная копия базы площадки. Запускается таймером zvonix-backup.timer (ставится выкладкой) и вручную:
#   sudo zvonix-backup
#
# Копия — формат custom (pg_restore), каталог /var/backups/zvonix/daily, владелец postgres, права 0700: в базе
# данные людей, читать копию не должен никто, кроме владельца базы. Хранятся последние KEEP_DAILY. Каждая копия
# проверяется: pg_restore должен прочитать её оглавление, иначе файл удаляется и скрипт падает — «снято»
# должно значить «можно восстановить». Копии записей разговоров здесь нет (они на диске площадки и могут
# весить много); как их сохранять — deploy/README.md, «Копии и восстановление».
set -euo pipefail

# Вид копии: daily (по умолчанию, по таймеру), manual (кнопка «Создать копию сейчас» в кабинете, ADR-0086) или
# before-restore (страховочная копия перед восстановлением, ADR-0086).
KIND="${1:-daily}"
case "$KIND" in
  daily) KEEP_DAILY="${ZVONIX_KEEP_DAILY:-14}" ;;
  manual) KEEP_DAILY="${ZVONIX_KEEP_MANUAL:-10}" ;;
  before-restore) KEEP_DAILY="${ZVONIX_KEEP_BEFORE_RESTORE:-5}" ;;
  *) echo "Ошибка: вид копии — daily, manual или before-restore" >&2; exit 1 ;;
esac
BACKUPS="/var/backups/zvonix/${KIND}"
DATABASE="${ZVONIX_DATABASE:-zvonix}"

die() {
  echo "Ошибка: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "нужны права root"

install -d -o postgres -g postgres -m 0700 /var/backups/zvonix "$BACKUPS"

file="${BACKUPS}/${KIND}-$(date +%Y%m%d-%H%M%S).dump"
# Из корня: у postgres нет прав на рабочий каталог root, и pg_dump ругался бы на него.
(cd / && sudo -u postgres pg_dump --format=custom --file="$file" "$DATABASE") || {
  rm -f -- "$file"
  die "копия базы не снята"
}
if [ ! -s "$file" ]; then
  rm -f -- "$file"
  die "копия базы пустая"
fi
# Оглавление читается — значит, файл целый; пустое оглавление у настоящей базы быть не может.
if [ "$(cd / && sudo -u postgres pg_restore --list "$file" | grep -c .)" -lt 10 ]; then
  rm -f -- "$file"
  die "копия базы не читается или в ней нет таблиц"
fi
echo "копия базы: ${file} ($(du -h "$file" | cut -f1))"

# Копия за пределами сервера. Включается файлом настроек; без него шаг пропускается, а локальная копия
# остаётся. Ошибка отправки роняет службу (видно в journalctl и в статусе), но не удаляет снятую копию.
OFFSITE_ENV=/etc/zvonix/backup-offsite.env
OFFSITE_KEY=/etc/zvonix/backup.key
offsite_failed=0
if [ -r "$OFFSITE_ENV" ]; then
  # shellcheck disable=SC1090
  . "$OFFSITE_ENV"
  [ -n "${ZVONIX_OFFSITE_REMOTE:-}" ] || die "в ${OFFSITE_ENV} не задан ZVONIX_OFFSITE_REMOTE (например, b2:zvonix-backups/prod)"
  command -v rclone >/dev/null 2>&1 || apt-get install -y -qq rclone >/dev/null 2>&1 || die "не установлен rclone"
  # Ключ шифрования создаётся один раз. Без него копия вне сервера нечитаема, поэтому его сохраняют отдельно.
  if [ ! -s "$OFFSITE_KEY" ]; then
    (umask 077 && openssl rand -base64 48 >"$OFFSITE_KEY")
    echo "создан ключ шифрования ${OFFSITE_KEY}: сохраните его вне сервера, без него копии не открыть"
  fi
  encrypted="${file}.enc"
  # Копия содержит данные людей: наружу уходит только зашифрованная.
  if openssl enc -aes-256-cbc -pbkdf2 -salt -pass "file:${OFFSITE_KEY}" -in "$file" -out "$encrypted" \
    && rclone ${ZVONIX_OFFSITE_RCLONE_CONFIG:+--config "$ZVONIX_OFFSITE_RCLONE_CONFIG"} copyto "$encrypted" \
      "${ZVONIX_OFFSITE_REMOTE%/}/$(basename "$encrypted")" \
    && rclone ${ZVONIX_OFFSITE_RCLONE_CONFIG:+--config "$ZVONIX_OFFSITE_RCLONE_CONFIG"} check --size-only --one-way \
      "$BACKUPS" "${ZVONIX_OFFSITE_REMOTE%/}" --include "$(basename "$encrypted")" >/dev/null 2>&1; then
    echo "копия вне сервера: ${ZVONIX_OFFSITE_REMOTE%/}/$(basename "$encrypted")"
  else
    offsite_failed=1
    echo "Ошибка: копия вне сервера не отправлена" >&2
  fi
  rm -f -- "$encrypted"
else
  echo "копия вне сервера не настроена (${OFFSITE_ENV} нет) — копия лежит только на этом сервере"
fi

# Лишние старые копии удаляются только после того, как свежая проверена.
while IFS= read -r old; do
  rm -f -- "$old"
  echo "удалена старая копия ${old}"
done < <(find "$BACKUPS" -maxdepth 1 -type f -name "${KIND}-*.dump" -printf '%T@ %p\n' \
  | sort -rn | tail -n +$((KEEP_DAILY + 1)) | cut -d' ' -f2-)

# Локальная копия снята и проверена, но отправка вне сервера не удалась: служба должна упасть, чтобы это увидели.
[ "$offsite_failed" -eq 0 ] || exit 1
