#!/usr/bin/env bash
# Установка площадки одной командой (ADR-0050). Запускается от root — на чистом сервере
# Ubuntu 24.04 или на уже подготовленном: каждый шаг повторяем.
#
# Строка установки — в deploy/README.md, «Установка одной командой». Она спрашивает токен
# GitHub скрытым вводом и передаёт его сюда переменной окружения GITHUB_TOKEN — не
# аргументом: аргументы видны в списке процессов.
#
#   install.sh [адрес кабинета]   адрес — как у server-setup.sh; по умолчанию стенд
#
# 1. узнаёт последний выпуск; 2. берёт каталог deploy/ той же метки; 3. готовит сервер
# (server-setup.sh, он же записывает токен); 4. выкладывает выпуск (zvonix-deploy). Выкладка,
# пока администратора нет, печатает код первого запуска.
set -euo pipefail

REPOSITORY="${GITHUB_REPOSITORY:-zvonix/zvonix-platform}"
TAG_PATTERN='^v?[0-9A-Za-z][0-9A-Za-z._-]*$'

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "нужны права root — строка установки запускает скрипт через sudo"
[ -n "${GITHUB_TOKEN:-}" ] || die "не передан токен GitHub — см. deploy/README.md, «Установка одной командой»"
for command in curl tar python3; do
  command -v "$command" >/dev/null 2>&1 || die "не найдена команда ${command}"
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Токен — файлом заголовков, как в deploy.sh: аргументы curl видны в списке процессов.
headers="${WORK}/headers"
(
  umask 077
  printf 'Authorization: Bearer %s\nX-GitHub-Api-Version: 2022-11-28\n' "$GITHUB_TOKEN" >"$headers"
)
api="https://api.github.com/repos/${REPOSITORY}"

step "Последний выпуск ${REPOSITORY}"
curl -fsSL --max-time 30 -H @"$headers" -H 'Accept: application/vnd.github+json' \
  -o "${WORK}/latest.json" "${api}/releases/latest" \
  || die "выпуск не найден — или токен не даёт читать репозиторий (deploy/README.md, «Токен GitHub»)"
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

GITHUB_REPOSITORY="$REPOSITORY" bash "${WORK}/source/deploy/server-setup.sh" "$@"

step "Выкладка ${tag}"
zvonix-deploy "$tag"
