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
API_READY=http://127.0.0.1:8000/health/ready
WEB_READY=http://127.0.0.1:3000/login
TAG_PATTERN='^v?[0-9A-Za-z][0-9A-Za-z._-]*$'

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "нужны права root"
for command in curl tar sha256sum node pnpm python3 systemctl sudo find pg_dump; do
  command -v "$command" >/dev/null 2>&1 \
    || die "не найдена команда ${command} — сначала deploy/server-setup.sh"
done
id zvonix >/dev/null 2>&1 || die "нет пользователя zvonix — сначала deploy/server-setup.sh"
[ -s "${ETC}/zvonix.env" ] || die "нет ${ETC}/zvonix.env — сначала deploy/server-setup.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Служба после перезапуска поднимается не сразу: ждём ответа 2xx до минуты.
wait_ready() {
  local url="$1" attempt
  for attempt in $(seq 1 60); do
    if curl -fsS --max-time 3 -o /dev/null "$url"; then
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
    install -m 0644 "${release}"/deploy/systemd/zvonix-*.service /etc/systemd/system/
    install -m 0755 "${release}/deploy/deploy.sh" /usr/local/sbin/zvonix-deploy
  fi
  point "$CURRENT" "$release"
  systemctl daemon-reload
  systemctl enable "${SERVICES[@]}" >/dev/null 2>&1
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

# Скачивание выпуска по токену только на чтение (ADR-0049).
download() {
  local tag="$1" env_file="${ETC}/github.env" headers api name id
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

  for name in "zvonix-${tag}.tgz" "zvonix-${tag}.tgz.sha256"; do
    id="$(python3 - "$name" "${WORK}/release.json" <<'PY'
import json, sys
name, path = sys.argv[1], sys.argv[2]
with open(path, encoding='utf-8') as source:
    assets = json.load(source).get('assets', [])
print(next((str(asset['id']) for asset in assets if asset.get('name') == name), ''))
PY
)"
    [ -n "$id" ] || die "в выпуске ${tag} нет файла ${name}"
    # Файл отдаёт хранилище GitHub переадресацией; заголовок авторизации curl на чужой
    # адрес не переносит.
    curl -fsSL --max-time 600 -H @"$headers" -H 'Accept: application/octet-stream' \
      -o "${WORK}/${name}" "${api}/releases/assets/${id}" \
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
