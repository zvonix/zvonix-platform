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

BACKUPS=/var/backups/zvonix/daily
DATABASE="${ZVONIX_DATABASE:-zvonix}"
KEEP_DAILY="${ZVONIX_KEEP_DAILY:-14}"

die() {
  echo "Ошибка: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "нужны права root"

install -d -o postgres -g postgres -m 0700 /var/backups/zvonix "$BACKUPS"

file="${BACKUPS}/daily-$(date +%Y%m%d-%H%M%S).dump"
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

# Лишние старые копии удаляются только после того, как свежая проверена.
while IFS= read -r old; do
  rm -f -- "$old"
  echo "удалена старая копия ${old}"
done < <(find "$BACKUPS" -maxdepth 1 -type f -name 'daily-*.dump' -printf '%T@ %p\n' \
  | sort -rn | tail -n +$((KEEP_DAILY + 1)) | cut -d' ' -f2-)
