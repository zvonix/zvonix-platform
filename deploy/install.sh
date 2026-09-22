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
#
# Каждый ответ переспрашивается, а пустой ответ сам по себе ничего не выбирает. Первый
# живой запуск 2026-09-22 поставил сервер без домена: на вопрос ответил лишний перевод
# строки, оставшийся в терминале после вставки токена (ADR-0050, ревизия).
ADDRESS_ARGS=()

# Набранное до вопроса — не ответ на него: строки, лежащие в буфере терминала, сливаются.
drain_tty() {
  local i discarded
  for i in 1 2 3 4 5 6 7 8 9 10; do
    read -r -t 0 </dev/tty || return 0
    read -r -t 1 discarded </dev/tty || return 0
  done
}

# «Да» — пусто при согласии по умолчанию или ответ на «д»/«y»; всё прочее — «нет».
confirm() {
  local answer=""
  read -rp "$1" answer </dev/tty || return 1
  answer="${answer//[[:space:]]/}"
  case "$answer" in
    '') [ "$2" = yes ] ;;
    д* | Д* | y* | Y*) return 0 ;;
    *) return 1 ;;
  esac
}

ask_address() {
  local current="" answer="" name
  (: </dev/tty) 2>/dev/null || return 0
  if [ -f /etc/zvonix/zvonix.env ]; then
    current="$(sed -n 's/^WEB_BASE_URL=//p' /etc/zvonix/zvonix.env | tail -1)"
  fi
  drain_tty
  {
    echo
    echo "Адрес кабинета — домен, например cp.zvonix.com: любой, чья запись A в DNS уже"
    echo "указывает на этот сервер. Сертификат https выпускается сразу."
    echo "Пустой ответ — ${current:-без домена, кабинет только через SSH-туннель}."
  } >/dev/tty
  while :; do
    read -rp 'Адрес кабинета: ' answer </dev/tty || die "ответа нет — установка остановлена, сервер не менялся"
    # Регистр — здесь, а не только в server-setup.sh: этот скрипт берётся из main,
    # а подготовка — из выпуска, который может быть старше.
    answer="$(printf '%s' "${answer//[[:space:]]/}" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$answer" ]; then
      if [ -n "$current" ]; then
        confirm "Оставить ${current}? [Д/н] " yes && return 0
      else
        confirm "Без домена кабинет откроется только через SSH-туннель. Ставить без домена? [д/Н] " no \
          && return 0
      fi
      continue
    fi
    # Грубая проверка формы, чтобы опечатка переспрашивалась здесь, а не останавливала
    # подготовку после скачивания. Окончательно адрес разбирает server-setup.sh.
    name="${answer#https://}"
    name="${name%/}"
    if [[ ! "$answer" =~ ^http://(localhost|127\.0\.0\.1):[0-9]{2,5}$ ]] \
      && [[ ! "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ || "$name" != *.* ]]; then
      echo "«${answer}» не похоже на домен — нужно имя вида cp.example.ru, без пути и порта" >/dev/tty
      continue
    fi
    if [[ "$answer" == http://* ]]; then
      confirm "Кабинет будет только через SSH-туннель, ${answer}. Верно? [Д/н] " yes || continue
    else
      confirm "Кабинет будет на https://${name}. Верно? [Д/н] " yes || continue
    fi
    ADDRESS_ARGS=("$answer")
    return 0
  done
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
