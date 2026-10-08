#!/usr/bin/env bash
# Выкладка площадки на сервер (ADR-0049). Запускается от root на самом сервере.
#
#   zvonix-deploy <метка>           скачать выпуск из GitHub Releases и перейти на него
#   zvonix-deploy --archive <файл>  выложить архив, привезённый руками
#   zvonix-deploy --rollback        вернуться на предыдущий выпуск
#
# Новый выпуск ставится рядом с работающим. Перед миграциями снимается копия базы
# (/var/backups/zvonix, пять последних); без неё миграции не идут. Миграции применяются
# до переключения: они совместимы с прежним кодом (ADR-0005). Потом меняется ссылка
# и перезапускаются службы. Не поднялся — ссылка возвращается на прежний выпуск.
# Миграции откат не откатывает — для этого и копия.
set -euo pipefail

ROOT=/opt/zvonix
RELEASES="${ROOT}/releases"
CURRENT="${ROOT}/current"
PREVIOUS="${ROOT}/previous"
ETC=/etc/zvonix
KEEP=5
BACKUPS=/var/backups/zvonix
# Имя базы — то, что заводит deploy/server-setup.sh.
DATABASE=zvonix
SERVICES=(zvonix-api zvonix-worker zvonix-web)
API_BASE=http://127.0.0.1:8000
API_READY="${API_BASE}/health/ready"
WEB_READY=http://127.0.0.1:3000/login
TAG_PATTERN='^v?[0-9A-Za-z][0-9A-Za-z._-]*$'

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "нужны права root"
for command in curl tar sha256sum node pnpm python3 systemctl sudo find pg_dump flock; do
  command -v "$command" >/dev/null 2>&1 \
    || die "не найдена команда ${command} — сначала deploy/server-setup.sh"
done
id zvonix >/dev/null 2>&1 || die "нет пользователя zvonix — сначала deploy/server-setup.sh"
[ -s "${ETC}/zvonix.env" ] || die "нет ${ETC}/zvonix.env — сначала deploy/server-setup.sh"

# Одна выкладка за раз: ручной запуск по SSH и кнопка в кабинете (ADR-0074) не должны столкнуться.
exec 9>/run/zvonix-deploy.lock
flock -n 9 || die "уже идёт другая выкладка"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Служба после перезапуска поднимается не сразу: ждём ответа 2xx до минуты.
wait_ready() {
  local url="$1" attempt
  for attempt in $(seq 1 60); do
    # Без -S: пока служба поднимается, каждая попытка «не соединилась» — штатна и только засоряет журнал.
    if curl -fs --max-time 3 -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
  done
  echo "не ответил ${url} (попыток: ${attempt})" >&2
  return 1
}

# Ссылка меняется подменой: `ln -sfn` поверх существующей ссылки не атомарен, и службы
# в промежутке увидели бы отсутствующий выпуск.
point() {
  ln -sfn "$2" "${1}.new"
  mv -Tf "${1}.new" "$1"
}

# Переход на выпуск: службы той же версии, ссылка, перезапуск, ожидание ответа.
activate() {
  local release="$1"
  if [ -d "${release}/deploy/systemd" ]; then
    install -m 0644 "${release}"/deploy/systemd/zvonix-*.service "${release}"/deploy/systemd/zvonix-*.timer       "${release}"/deploy/systemd/zvonix-*.path /etc/systemd/system/
    install -m 0755 "${release}/deploy/deploy.sh" /usr/local/sbin/zvonix-deploy
    # Ежедневная копия базы: сценарий и таймер ставятся выкладкой, как и службы.
    install -m 0755 "${release}/deploy/backup.sh" /usr/local/sbin/zvonix-backup
    # Обновление из кабинета (ADR-0074): служба от root и каталог обмена с API. Служба
    # обновления выкладкой не перезапускается — она сама её и запускает.
    install -m 0755 "${release}/deploy/updater.py" /usr/local/sbin/zvonix-updater
    install -d -o root -g root -m 0755 /var/lib/zvonix-updater /var/lib/zvonix-updater/runs
    install -d -o zvonix -g zvonix -m 0750 /var/lib/zvonix-updater/requests
  fi
  point "$CURRENT" "$release"
  systemctl daemon-reload
  systemctl enable "${SERVICES[@]}" >/dev/null 2>&1
  systemctl enable --now zvonix-backup.timer >/dev/null 2>&1 || echo "ВНИМАНИЕ: таймер копий не включён" >&2
  systemctl enable --now zvonix-updater.path zvonix-updater.timer >/dev/null 2>&1     || echo "ВНИМАНИЕ: обновление из кабинета не включено" >&2
  systemctl restart "${SERVICES[@]}"
  wait_ready "$API_READY" && wait_ready "$WEB_READY"
}

# Старые выпуски, кроме текущего и предыдущего: хранятся KEEP последних.
prune() {
  local current previous index=0 release
  current="$(readlink -f "$CURRENT" 2>/dev/null || true)"
  previous="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
  while IFS= read -r release; do
    index=$((index + 1))
    if [ "$index" -le "$KEEP" ] || [ "$release" = "$current" ] || [ "$release" = "$previous" ]; then
      continue
    fi
    rm -rf -- "$release"
    echo "удалён старый выпуск ${release}"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}

# Записи о подготовленных выпусках живут двое суток: дольше подготовка всё равно считается устаревшей.
prune_prepared() {
  [ -d "$PREPARED" ] && find "$PREPARED" -maxdepth 1 -type f -name '*.json' -mtime +2 -delete
  return 0
}

# Копия базы перед миграциями. Откат выпуска возвращает код, но не базу (ADR-0049):
# данные, испорченные миграцией, возвращаются только из копии. Нет копии — нет миграций.
# Снимает сам postgres в свой каталог: у root роли в базе нет, а копия с данными людей
# не должна быть читаема никем, кроме владельца базы. Хранятся KEEP последних.
backup_database() {
  local label="$1" file old
  file="${BACKUPS}/${label}-$(date +%Y%m%d%H%M%S).dump"
  install -d -o postgres -g postgres -m 0700 "$BACKUPS"
  # Из корня: у postgres нет прав на рабочий каталог root, и pg_dump ругался бы на него.
  (cd / && sudo -u postgres pg_dump --format=custom --file="$file" "$DATABASE") || {
    rm -f -- "$file"
    die "копия базы не снята — миграции не применялись, работает прежний выпуск"
  }
  # Пустой файл удаляется: иначе он занял бы место среди KEEP и вытеснил настоящую копию.
  if [ ! -s "$file" ]; then
    rm -f -- "$file"
    die "копия базы пустая — миграции не применялись, работает прежний выпуск"
  fi
  echo "копия базы: ${file} ($(du -h "$file" | cut -f1))"
  while IFS= read -r old; do
    rm -f -- "$old"
    echo "удалена старая копия ${old}"
  done < <(find "$BACKUPS" -maxdepth 1 -type f -name '*.dump' -printf '%T@ %p\n' \
    | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)
}

# Код первого запуска (ADR-0050): печатается, только пока администратора нет. До строки
# DEPLOY_OK — она последняя по договорённости. Сбой здесь выкладку не отменяет: выпуск
# уже работает, а код можно получить той же командой отдельно (deploy/README.md).
first_run_hint() {
  sudo -u zvonix sh -c \
    'set -a; . /etc/zvonix/zvonix.env; set +a; cd "$0/apps/api" && exec node dist/modules/identity/first-run-code.js' \
    "$1" || echo "код первого запуска не получен — см. deploy/README.md, «Первый вход»" >&2
}

# Узел АТС на этой же машине получает набор нового выпуска: конфигурацию FreeSWITCH,
# правила fail2ban, пульс (ADR-0051, ревизия 2026-09-29). Признак узла — его ключ
# в /etc/zvonix-node. Скрипт берётся у только что поднятого API: это набор ровно этого
# выпуска. Сбой выкладку не отменяет — площадка уже работает, а узел обновляется
# отдельно той же командой (zvonix-node-update).
update_local_node() {
  local script
  [ -f /etc/zvonix-node/node.env ] || [ -f /etc/zvonix-node/heartbeat.curl ] || return 0
  step "Узел АТС на этой машине"
  script="${WORK}/node-install.sh"
  if curl -fsS --max-time 30 -o "$script" "${API_BASE}/install.sh" && bash "$script" --update; then
    return 0
  fi
  echo "ВНИМАНИЕ: узел АТС не обновлён — площадка работает; повторите zvonix-node-update" >&2
}

# Пока фоновая команда работает, раз в `interval` секунд печатает строку о ходе: человек в кабинете видит, что
# обновление идёт, а не зависло (2026-10-08: десять минут тишины на медленном канале). `describe` получает
# прошедшие секунды и печатает строку; ждёт процесс и возвращает его код.
watch_progress() {
  local pid="$1" interval="$2" describe="$3" started now
  started="$(date +%s)"
  while kill -0 "$pid" 2>/dev/null; do
    sleep "$interval"
    kill -0 "$pid" 2>/dev/null || break
    now="$(date +%s)"
    "$describe" "$((now - started))"
  done
  wait "$pid"
}

# Строка хода скачивания: сколько получено, процент, скорость и сколько осталось. Размер и файл — в переменных
# DOWNLOAD_*: функции `watch_progress` аргументы нужны только временные.
describe_download() {
  local elapsed="$1" size speed left
  size="$(stat -c %s "$DOWNLOAD_OUT" 2>/dev/null || echo 0)"
  speed=$(((size - DOWNLOAD_LAST) / ${DOWNLOAD_INTERVAL}))
  DOWNLOAD_LAST="$size"
  if [ "$DOWNLOAD_TOTAL" -gt 0 ]; then
    left=""
    [ "$speed" -gt 0 ] && left=", осталось около $(((DOWNLOAD_TOTAL - size) / speed)) с"
    printf '  скачано %s из %s КБ (%s%%), %s КБ/с%s\n' "$((size / 1024))" "$((DOWNLOAD_TOTAL / 1024))" \
      "$((size * 100 / DOWNLOAD_TOTAL))" "$((speed / 1024))" "$left"
  else
    printf '  скачано %s КБ, %s КБ/с, прошло %s с\n' "$((size / 1024))" "$((speed / 1024))" "$elapsed"
  fi
}

# Канал сервера до GitHub бывает очень медленным (2026-10-06: около 11 КБ/с, архив в 15 МБ не
# укладывался в десять минут). Поэтому каждая попытка продолжает файл с места обрыва, а не
# начинает заново, и попыток несколько. Ход скачивания — строка каждые десять секунд; строки попыток
# видны в журнале обновления из кабинета.
fetch_resumable() {
  local out="$1" url="$2" headers="$3" total="${4:-0}" attempt pid
  DOWNLOAD_OUT="$out" DOWNLOAD_TOTAL="$total" DOWNLOAD_INTERVAL=10
  for attempt in 1 2 3 4 5 6; do
    DOWNLOAD_LAST="$(stat -c %s "$out" 2>/dev/null || echo 0)"
    curl -fsSL -C - --max-time 600 -H @"$headers" -H 'Accept: application/octet-stream' \
      -o "$out" "$url" &
    pid=$!
    if watch_progress "$pid" "$DOWNLOAD_INTERVAL" describe_download; then
      return 0
    fi
    echo "скачивание не завершилось (попытка ${attempt} из 6), продолжаю с места обрыва: $(du -h "$out" 2>/dev/null | cut -f1)" >&2
    sleep 3
  done
  return 1
}

# Долгая команда с отметкой «идёт N с» раз в 15 секунд: установка зависимостей молчит минутами.
describe_elapsed() { printf '  идёт, прошло %s с\n' "$1"; }
run_with_heartbeat() {
  "$@" &
  watch_progress "$!" 15 describe_elapsed
}

# Скачивание выпуска по токену только на чтение (ADR-0049).
download() {
  local tag="$1" env_file="${ETC}/github.env" headers api name id size release_id
  [ -r "$env_file" ] || die "нет ${env_file} — см. deploy/README.md, «Токен GitHub»"
  # shellcheck source=/dev/null
  . "$env_file"
  [ -n "${GITHUB_REPOSITORY:-}" ] || die "в ${env_file} не задан GITHUB_REPOSITORY (владелец/репозиторий)"
  [ -n "${GITHUB_TOKEN:-}" ] || die "в ${env_file} не задан GITHUB_TOKEN"

  # Токен — файлом заголовков, а не аргументом: аргументы видны в списке процессов.
  headers="${WORK}/headers"
  (
    umask 077
    printf 'Authorization: Bearer %s\nX-GitHub-Api-Version: 2022-11-28\n' "$GITHUB_TOKEN" >"$headers"
  )
  api="https://api.github.com/repos/${GITHUB_REPOSITORY}"

  step "Выпуск ${tag} из ${GITHUB_REPOSITORY}"
  curl -fsSL --max-time 30 -H @"$headers" -H 'Accept: application/vnd.github+json' \
    -o "${WORK}/release.json" "${api}/releases/tags/${tag}" \
    || die "выпуск ${tag} не найден — или токен не даёт читать выпуски репозитория"
  release_id="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["id"])' "${WORK}/release.json")"

  # Файлы — отдельным запросом, а не полем `assets` выпуска: у v0.1.6 это поле часами
  # приходило пустым при загруженных файлах, и выкладка отказывала на исправном выпуске
  # (TASKS.md, 2026-09-23). Список файлов выпуска в это время отвечал верно.
  curl -fsSL --max-time 30 -H @"$headers" -H 'Accept: application/vnd.github+json' \
    -o "${WORK}/assets.json" "${api}/releases/${release_id}/assets?per_page=100" \
    || die "не удалось получить список файлов выпуска ${tag}"

  for name in "zvonix-${tag}.tgz" "zvonix-${tag}.tgz.sha256"; do
    # «идентификатор размер» файла в выпуске; размер нужен для процента скачивания.
    id="$(python3 - "$name" "${WORK}/assets.json" <<'PY'
import json, sys
name, path = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as source:
    assets = json.load(source)
found = next((asset for asset in assets if asset.get('name') == name), None)
print('' if found is None else '%s %s' % (found['id'], found.get('size', 0)))
PY
)"
    [ -n "$id" ] || die "в выпуске ${tag} нет файла ${name}"
    size="${id#* }"
    id="${id%% *}"
    # Файл отдаёт хранилище GitHub переадресацией; заголовок авторизации curl на чужой
    # адрес не переносит.
    fetch_resumable "${WORK}/${name}" "${api}/releases/assets/${id}" "$headers" "$size" \
      || die "не удалось скачать ${name}"
  done

  (cd "$WORK" && sha256sum -c --quiet "zvonix-${tag}.tgz.sha256") \
    || die "контрольная сумма zvonix-${tag}.tgz не совпала"
}

# Распаковка архива и зависимости. Каталог выпуска — в RELEASE_DIR (не в выводе: шаги печатают в журнал).
unpack_release() {
  local archive="$1" label="$2" release
  release="${RELEASES}/${label}-$(date +%Y%m%d%H%M%S)"

  step "Распаковка в ${release}"
  install -d -o zvonix -g zvonix -m 0750 "$RELEASES" "$release"
  run_with_heartbeat tar -xzf "$archive" -C "$release" --strip-components=1
  [ -f "${release}/RELEASE" ] || die "в архиве нет файла RELEASE — это не выпуск площадки"
  chown -R zvonix:zvonix "$release"

  step "Зависимости API и воркера"
  # Версию pnpm берёт corepack из `packageManager` выпуска.
  run_with_heartbeat sudo -u zvonix -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
    sh -c 'cd "$0" && pnpm install --frozen-lockfile --prod --filter "@zvonix/api..." --filter "@zvonix/worker..."' \
    "$release"
  RELEASE_DIR="$release"
}

# Подготовленный выпуск (ADR-0074, этап 2): скачан, распакован и проверен заранее. Запись о нём —
# ${PREPARED}/<метка>.json; годится, пока каталог цел, метка в нём та же и проверка прошла не давно.
PREPARED="${UPDATER_DIR:-/var/lib/zvonix-updater}/prepared"
PREPARED_MAX_AGE=21600
prepared_release() {
  local tag="$1" record="${PREPARED}/${1}.json"
  [ -f "$record" ] || return 1
  python3 - "$record" "$tag" "$PREPARED_MAX_AGE" <<'PY'
import json, os, sys, time
record, tag, max_age = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = json.load(open(record, encoding='utf-8'))
release = data.get('release', '')
release_file = os.path.join(release, 'RELEASE')
if not data.get('ok') or not os.path.isfile(release_file):
    sys.exit(1)
if open(release_file, encoding='utf-8').readline().strip() != tag:
    sys.exit(1)
if time.time() - os.stat(record).st_mtime > max_age:
    sys.exit(1)
print(release)
PY
}

# --- Проверка выпуска до установки (ADR-0074, этап 2) -----------------------------------------
# Результат каждой проверки — строка «имя|ok/warn/fail|подробности» в ${CHECKS}; `fail` останавливает
# установку, `warn` только предупреждает. Прогон идёт на ВРЕМЕННОЙ копии базы и запасном порту:
# рабочие база и службы не затрагиваются.
CHECKS=""
REHEARSAL_DB=zvonix_rehearsal
REHEARSAL_PORT=18000

check() {
  printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$CHECKS"
  printf 'ПРОВЕРКА %s: %s — %s\n' "$1" "$2" "$3"
}

# Свободное место: выпуск (с зависимостями) и копия базы перед миграциями.
check_disk() {
  local free_opt free_backup
  free_opt="$(df -Pm "$ROOT" | awk 'NR==2 {print $4}')"
  install -d -o postgres -g postgres -m 0700 "$BACKUPS"
  free_backup="$(df -Pm "$BACKUPS" | awk 'NR==2 {print $4}')"
  if [ "$free_opt" -lt 1024 ] || [ "$free_backup" -lt 512 ]; then
    check "Место на диске" fail "мало: для выпусков ${free_opt} МБ (нужно от 1024), для копий ${free_backup} МБ (от 512)"
  else
    check "Место на диске" ok "для выпусков ${free_opt} МБ, для копий ${free_backup} МБ"
  fi
}

# Суточная копия базы: перед миграциями выкладка снимет свою, но свежая суточная — второй рубеж.
check_daily_backup() {
  local newest age_hours
  newest="$(find "${BACKUPS}/daily" -maxdepth 1 -type f -name '*.dump' -printf '%T@\n' 2>/dev/null | sort -rn | head -1)"
  if [ -z "$newest" ]; then
    check "Суточная копия базы" warn "суточных копий нет — только копия перед миграциями"
    return 0
  fi
  age_hours=$(( ($(date +%s) - ${newest%.*}) / 3600 ))
  if [ "$age_hours" -gt 36 ]; then
    check "Суточная копия базы" warn "последней суточной копии ${age_hours} ч — таймер копий не работает?"
  else
    check "Суточная копия базы" ok "последней ${age_hours} ч"
  fi
}

check_release_files() {
  local release="$1" tag="$2" first
  first="$(head -1 "${release}/RELEASE")"
  if [ "$first" != "$tag" ]; then
    check "Состав выпуска" fail "метка в выпуске «${first}», ожидалась «${tag}»"
  elif [ ! -f "${release}/apps/api/dist/main.js" ] || [ ! -d "${release}/apps/web/.next" ]; then
    check "Состав выпуска" fail "нет собранного API или кабинета"
  else
    check "Состав выпуска" ok "${tag}, собраны API и кабинет"
  fi
}

rehearsal_cleanup() {
  (cd / && sudo -u postgres dropdb --if-exists "$REHEARSAL_DB") >/dev/null 2>&1 || true
}

# Репетиция: копия рабочей базы → миграции выпуска на ней → API выпуска на запасном порту отвечает «готов».
# Ловит то, что не видно по тексту миграций: поведение на настоящих данных и запуск нового кода.
check_rehearsal() {
  local release="$1" live_url test_url pid ready=0 attempt
  live_url="$(set -a; . "${ETC}/zvonix.env"; printf '%s' "${DATABASE_URL:-}")"
  if [ -z "$live_url" ]; then
    check "Репетиция на копии базы" fail "в zvonix.env нет DATABASE_URL"
    return 0
  fi
  test_url="${live_url%/*}/${REHEARSAL_DB}"

  rehearsal_cleanup
  if ! (cd / && sudo -u postgres createdb -O zvonix "$REHEARSAL_DB") >/dev/null 2>&1; then
    check "Репетиция на копии базы" fail "не удалось создать временную базу ${REHEARSAL_DB}"
    return 0
  fi
  if ! (cd / && sudo -u postgres pg_dump --format=custom "$DATABASE" \
      | sudo -u postgres pg_restore --no-owner --role=zvonix -d "$REHEARSAL_DB") >"${WORK}/rehearsal-restore.log" 2>&1; then
    check "Репетиция на копии базы" fail "копия рабочей базы не развернулась: $(tail -2 "${WORK}/rehearsal-restore.log" | tr '\n' ' ')"
    rehearsal_cleanup
    return 0
  fi

  if ! sudo -u zvonix sh -c 'set -a; . /etc/zvonix/zvonix.env; set +a; export DATABASE_URL="$1"; cd "$0" && exec node packages/db/dist/migrate.js' \
      "$release" "$test_url" >"${WORK}/rehearsal-migrate.log" 2>&1; then
    check "Репетиция на копии базы" fail "миграции не прошли на копии данных: $(tail -3 "${WORK}/rehearsal-migrate.log" | tr '\n' ' ')"
    rehearsal_cleanup
    return 0
  fi

  # API выпуска на запасном порту, только на себя; SMPP и обмен с службой обновления выключены.
  sudo -u zvonix sh -c 'set -a; . /etc/zvonix/zvonix.env; set +a; export DATABASE_URL="$1" APP_HOST=127.0.0.1 APP_PORT="$2" SMPP_PORT=0 SMPP_TLS_PORT=0 UPDATER_DIR=/nonexistent; cd "$0/apps/api" && exec node dist/main.js' \
    "$release" "$test_url" "$REHEARSAL_PORT" >"${WORK}/rehearsal-api.log" 2>&1 &
  pid=$!
  for attempt in $(seq 1 40); do
    if curl -fs --max-time 2 -o /dev/null "http://127.0.0.1:${REHEARSAL_PORT}/health/ready"; then
      ready=1
      break
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rehearsal_cleanup

  if [ "$ready" -eq 1 ]; then
    check "Репетиция на копии базы" ok "миграции прошли на копии данных, API выпуска запустился на порту ${REHEARSAL_PORT}"
  else
    check "Репетиция на копии базы" fail "API выпуска не стал готов: $(tail -3 "${WORK}/rehearsal-api.log" | tr '\n' ' ' | cut -c1-300)"
  fi
}

# Все проверки выпуска; запись о результате — ${PREPARED}/<метка>.json. Код возврата: 0 — можно ставить.
run_checks() {
  # Для `--archive` метка — имя файла (zvonix-v0.1.0): в выпуске она без приставки.
  local release="$1" tag="${2#zvonix-}" record
  record="${PREPARED}/${tag}.json"
  CHECKS="${WORK}/checks.txt"
  : >"$CHECKS"

  step "Проверка выпуска перед установкой"
  check_disk
  check_daily_backup
  check_release_files "$release" "$tag"
  # Репетиция имеет смысл, только если выпуск цел: иначе она упадёт по более глупой причине.
  if ! grep -q '|fail|' "$CHECKS"; then
    check_rehearsal "$release"
  fi

  install -d -m 0755 "$PREPARED"
  if python3 - "$CHECKS" "$record" "$tag" "$release" <<'PY'
import json, sys, time
checks_file, record, tag, release = sys.argv[1:5]
items = []
for line in open(checks_file, encoding='utf-8'):
    name, status, detail = line.rstrip('\n').split('|', 2)
    items.append({'name': name, 'status': status, 'detail': detail})
ok = bool(items) and all(item['status'] != 'fail' for item in items)
data = {'tag': tag, 'release': release, 'ok': ok, 'checked_at': time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime()), 'checks': items}
with open(record + '.tmp', 'w', encoding='utf-8') as handle:
    json.dump(data, handle, ensure_ascii=False)
import os
os.chmod(record + '.tmp', 0o644)
os.replace(record + '.tmp', record)
sys.exit(0 if ok else 1)
PY
  then
    return 0
  fi
  # Не прошёл проверку — каталог не нужен: он занимал бы место среди сохраняемых выпусков.
  rm -rf -- "$release"
  return 1
}

install_release() {
  local archive="$1" label="$2" prepared="${3:-}" release before

  if [ -n "$prepared" ]; then
    step "Выпуск уже подготовлен и проверен: ${prepared}"
    release="$prepared"
  else
    unpack_release "$archive" "$label"
    release="$RELEASE_DIR"
    run_checks "$release" "$label" \
      || die "проверка выпуска не пройдена — установка остановлена, работает прежний выпуск"
  fi

  step "Копия базы"
  backup_database "$label"

  step "Миграции"
  sudo -u zvonix sh -c 'set -a; . /etc/zvonix/zvonix.env; set +a; cd "$0" && exec node packages/db/dist/migrate.js' \
    "$release"

  before=""
  if [ -L "$CURRENT" ]; then
    before="$(readlink -f "$CURRENT")"
  fi

  step "Переход на выпуск"
  if activate "$release"; then
    if [ -n "$before" ]; then
      point "$PREVIOUS" "$before"
    fi
    prune
    prune_prepared
    update_local_node
    first_run_hint "$release"
    echo "DEPLOY_OK $(head -1 "${release}/RELEASE")"
    return 0
  fi

  [ -n "$before" ] || die "выпуск не поднялся, а прежнего нет — journalctl -u zvonix-api -u zvonix-web"
  echo "Выпуск не поднялся — возвращаю ${before}" >&2
  activate "$before" || die "не поднялся и прежний выпуск ${before} — journalctl -u zvonix-api -u zvonix-web"
  die "выпуск ${release} не поднялся, работает прежний ${before}"
}

rollback() {
  local target current
  [ -L "$PREVIOUS" ] || die "предыдущего выпуска нет"
  target="$(readlink -f "$PREVIOUS")"
  current="$(readlink -f "$CURRENT")"
  [ -d "$target" ] || die "предыдущий выпуск ${target} удалён"

  step "Откат на ${target}"
  activate "$target" || die "предыдущий выпуск не поднялся — journalctl -u zvonix-api -u zvonix-web"
  point "$PREVIOUS" "$current"
  update_local_node
  echo "ROLLBACK_OK ${target}"
}

case "${1:-}" in
  --prepare)
    # Заранее: скачать, распаковать и проверить на копии базы — ничего не устанавливая (ADR-0074).
    tag="${2:-}"
    [[ "$tag" =~ $TAG_PATTERN ]] || die "укажите метку: zvonix-deploy --prepare <метка>"
    if prepared_release "$tag" >/dev/null; then
      echo "Выпуск ${tag} уже подготовлен и проверен"
    else
      download "$tag"
      unpack_release "${WORK}/zvonix-${tag}.tgz" "$tag"
      run_checks "$RELEASE_DIR" "$tag" || die "проверка выпуска ${tag} не пройдена — устанавливать нельзя"
    fi
    echo "PREPARE_OK ${tag}"
    ;;
  --rollback)
    rollback
    ;;
  --archive)
    archive="${2:-}"
    [ -f "$archive" ] || die "укажите файл архива: zvonix-deploy --archive <файл>"
    label="$(basename "$archive" .tgz)"
    [[ "$label" =~ $TAG_PATTERN ]] || die "имя архива ${label} недопустимо"
    if [ -f "${archive}.sha256" ]; then
      (cd "$(dirname "$archive")" && sha256sum -c --quiet "$(basename "$archive").sha256") \
        || die "контрольная сумма ${archive} не совпала"
    fi
    install_release "$archive" "$label"
    ;;
  "" | -h | --help)
    sed -n '4,6p' "$0"
    exit 1
    ;;
  -*)
    die "неизвестный ключ $1"
    ;;
  *)
    [[ "$1" =~ $TAG_PATTERN ]] || die "метка $1 недопустима"
    prepared="$(prepared_release "$1" || true)"
    if [ -n "$prepared" ]; then
      install_release "" "$1" "$prepared"
    else
      download "$1"
      install_release "${WORK}/zvonix-${1}.tgz" "$1"
    fi
    rm -f -- "${PREPARED}/${1}.json"
    ;;
esac
