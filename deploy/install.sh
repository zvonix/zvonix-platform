#!/usr/bin/env bash
# Установка площадки одной командой (ADR-0050). Запускается от root — на чистом сервере
# Ubuntu 24.04 или на уже подготовленном: каждый шаг повторяем.
#
# Строка установки — в deploy/README.md, «Установка одной командой». Она спрашивает токен
# GitHub скрытым вводом и передаёт его сюда переменной окружения GITHUB_TOKEN — не
# аргументом: аргументы видны в списке процессов.
#
#   install.sh [адрес кабинета]   адрес — как у server-setup.sh. Без него скрипт спрашивает
#                                 адрес в терминале; Enter оставляет записанный
#
# 1. спрашивает адрес кабинета; 2. узнаёт последний выпуск; 3. берёт каталог deploy/ той же
# метки; 4. готовит сервер (server-setup.sh: сайт, сертификат, токен); 5. выкладывает
# выпуск (zvonix-deploy). Выкладка, пока администратора нет, печатает код первого запуска.
#
# Всё тело — в функции main, вызываемой последней строкой. Скрипт приходит в bash через
# канал: без функции bash исполнял бы его по мере чтения, оборванная загрузка выполнилась
# бы наполовину, а команда, читающая ввод, съела бы остаток скрипта.
set -euo pipefail

REPOSITORY="${GITHUB_REPOSITORY:-zvonix/zvonix-platform}"
TAG_PATTERN='^v?[0-9A-Za-z][0-9A-Za-z._-]*$'

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

# Адрес кабинета — ответом в терминале. Ввод скрипта занят им самим, поэтому вопрос
# читается из /dev/tty; терминала нет (запуск без человека) — адрес выбирает подготовка.
ADDRESS_ARGS=()
ask_address() {
  local current="" answer=""
  (: </dev/tty) 2>/dev/null || return 0
  if [ -f /etc/zvonix/zvonix.env ]; then
    current="$(sed -n 's/^WEB_BASE_URL=//p' /etc/zvonix/zvonix.env | tail -1)"
  fi
  {
    echo
    echo "Адрес кабинета — домен, например cp.zvonix.com. Его запись A в DNS уже должна"
    echo "указывать на этот сервер: сертификат https выпускается сразу."
    echo "Enter — оставить: ${current:-без домена, кабинет через SSH-туннель}"
  } >/dev/tty
  read -rp 'Адрес кабинета: ' answer </dev/tty
  answer="${answer//[[:space:]]/}"
  if [ -n "$answer" ]; then
    ADDRESS_ARGS=("$answer")
  fi
}

main() {
  [ "$(id -u)" -eq 0 ] || die "нужны права root — строка установки запускает скрипт через sudo"
  [ -n "${GITHUB_TOKEN:-}" ] || die "не передан токен GitHub — см. deploy/README.md, «Установка одной командой»"
  for command in curl tar python3; do
    command -v "$command" >/dev/null 2>&1 || die "не найдена команда ${command}"
  done

  if [ "$#" -gt 0 ]; then
    ADDRESS_ARGS=("$1")
  else
    ask_address
  fi

  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  # Токен — файлом заголовков, как в deploy.sh: аргументы curl видны в списке процессов.
  local headers="${WORK}/headers"
  (
    umask 077
    printf 'Authorization: Bearer %s\nX-GitHub-Api-Version: 2022-11-28\n' "$GITHUB_TOKEN" >"$headers"
  )
  local api="https://api.github.com/repos/${REPOSITORY}"

  step "Последний выпуск ${REPOSITORY}"
  curl -fsSL --max-time 30 -H @"$headers" -H 'Accept: application/vnd.github+json' \
    -o "${WORK}/latest.json" "${api}/releases/latest" \
    || die "выпуск не найден — или токен не даёт читать репозиторий (deploy/README.md, «Токен GitHub»)"
  local tag
  tag="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["tag_name"])' \
    "${WORK}/latest.json")"
  [[ "$tag" =~ $TAG_PATTERN ]] || die "метка выпуска «${tag}» недопустима"
  echo "выпуск ${tag}"

  # Скрипты подготовки — той же метки, что и выпуск: иначе новый скрипт готовил бы сервер
  # под выпуск, которого ещё нет, или старый — под тот, что уже вышел.
  step "Скрипты подготовки ${tag}"
  curl -fsSL --max-time 120 -H @"$headers" -o "${WORK}/source.tgz" "${api}/tarball/${tag}" \
    || die "не удалось скачать исходники ${tag}"
  mkdir "${WORK}/source"
  tar -xzf "${WORK}/source.tgz" -C "${WORK}/source" --strip-components=1 --wildcards '*/deploy/*'
  [ -f "${WORK}/source/deploy/server-setup.sh" ] || die "в исходниках ${tag} нет deploy/server-setup.sh"

  GITHUB_REPOSITORY="$REPOSITORY" bash "${WORK}/source/deploy/server-setup.sh" "${ADDRESS_ARGS[@]}"

  step "Выкладка ${tag}"
  zvonix-deploy "$tag"
}

main "$@"
