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

# Канал сервера до GitHub бывает очень медленным (2026-10-06: около 11 КБ/с, архив в 15 МБ не
# укладывался в десять минут). Поэтому каждая попытка продолжает файл с места обрыва, а не
# начинает заново, и попыток несколько. Строки попыток видны в журнале обновления из кабинета.
fetch_resumable() {
  local out="$1" url="$2" headers="$3" attempt
  for attempt in 1 2 3 4 5 6; do
    if curl -fsSL -C - --max-time 600 -H @"$headers" -H 'Accept: application/octet-stream' \
      -o "$out" "$url"; then
      return 0
    fi
    echo "скачивание не завершилось (попытка ${attempt} из 6), продолжаю с места обрыва: $(du -h "$out" 2>/dev/null | cut -f1)" >&2
    sleep 3
  done
  return 1
}

# Скачивание выпуска по токену только на чтение (ADR-0049).
download() {
  local tag="$1" env_file="${ETC}/github.env" headers api name id release_id
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
    id="$(python3 - "$name" "${WORK}/assets.json" <<'PY'
import json, sys
name, path = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as source:
    assets = json.load(source)
print(next((str(asset['id']) for asset in assets if asset.get('name') == name), ''))
PY
)"
    [ -n "$id" ] || die "в выпуске ${tag} нет файла ${name}"
    # Файл отдаёт хранилище GitHub переадресацией; заголовок авторизации curl на чужой
    # адрес не переносит.
    fetch_resumable "${WORK}/${name}" "${api}/releases/assets/${id}" "$headers" \
      || die "не удалось скачать ${name}"
  done

  (cd "$WORK" && sha256sum -c --quiet "zvonix-${tag}.tgz.sha256") \
    || die "контрольная сумма zvonix-${tag}.tgz не совпала"
}

install_release() {
  local archive="$1" label="$2" release before
  release="${RELEASES}/${label}-$(date +%Y%m%d%H%M%S)"

  step "Распаковка в ${release}"
  install -d -o zvonix -g zvonix -m 0750 "$RELEASES" "$release"
  tar -xzf "$archive" -C "$release" --strip-components=1
  [ -f "${release}/RELEASE" ] || die "в архиве нет файла RELEASE — это не выпуск площадки"
  chown -R zvonix:zvonix "$release"

  step "Зависимости API и воркера"
  # Версию pnpm берёт corepack из `packageManager` выпуска.
  sudo -u zvonix -H env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
    sh -c 'cd "$0" && pnpm install --frozen-lockfile --prod --filter "@zvonix/api..." --filter "@zvonix/worker..."' \
    "$release"

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
    download "$1"
    install_release "${WORK}/zvonix-${1}.tgz" "$1"
    ;;
esac
