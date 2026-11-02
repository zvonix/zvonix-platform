#!/usr/bin/env bash
# Проба выкладки на настоящей Ubuntu (ADR-0109): только CI, от root — запускать на рабочей машине нельзя.
#
#   sudo env "PATH=$PATH" bash scripts/deploy-check.sh <архив выпуска>
#
# Функции берутся прямо из deploy/deploy.sh, а не копируются: проверяется то, что поедет на сервер. Настоящий архив,
# настоящая распаковка от root, настоящий юнит кабинета с его ограничениями. На Windows этого не проверить, а ошибка
# здесь на сервере означала бы, что кнопка «Обновить» перестала работать и чинить можно только по SSH.
set -euo pipefail

ARCHIVE="${1:?укажите архив выпуска}"
[ "$(id -u)" -eq 0 ] || { echo "нужны права root" >&2; exit 1; }
[ "${CI:-}" = true ] || { echo "только в CI: сценарий заводит пользователя и службы" >&2; exit 1; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="${REPO}/deploy/deploy.sh"
ARCHIVE="$(readlink -f "$ARCHIVE")"

# Многострочная функция сценария выкладки — от `имя() {` до первой `}` в начале строки.
for name in watch_progress run_with_heartbeat unpack_release web_cache harden_release verify_signature; do
  body="$(sed -n "/^${name}() {/,/^}/p" "$DEPLOY")"
  [ -n "$body" ] || { echo "в deploy.sh нет функции ${name}" >&2; exit 1; }
  eval "$body"
done
# Однострочные — из того же файла.
eval "$(grep -E '^describe_elapsed\(\)' "$DEPLOY")"
eval "$(grep -E '^step\(\)' "$DEPLOY")"
eval "$(sed -n '/^die() {/,/^}/p' "$DEPLOY")"
eval "$(grep -E '^(RELEASE_NAMESPACE|WEB_CACHE)=' "$DEPLOY")"

RELEASES=/opt/zvonix/releases
WORK="$(mktemp -d)"
trap 'systemctl stop zvonix-web 2>/dev/null || true; rm -rf "$WORK"' EXIT

fail() {
  echo "ПРОБА ВЫКЛАДКИ НЕ ПРОШЛА: $*" >&2
  exit 1
}

step "Окружение как на сервере"
# Сборщик CI настроил sudo не как обычная Ubuntu: HOME и XDG_* проходят насквозь, и pnpm от zvonix полез бы в
# настройки /home/runner. Здесь sudo приводится к виду сервера.
unset XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME PNPM_HOME
printf 'Defaults env_reset\nDefaults always_set_home\nDefaults env_keep -= "HOME XDG_CONFIG_HOME"\n' \
  >/etc/sudoers.d/zz-deploy-check
chmod 0440 /etc/sudoers.d/zz-deploy-check
visudo -cqf /etc/sudoers.d/zz-deploy-check
# Образ CI пишет XDG_CONFIG_HOME ещё и в /etc/environment, откуда sudo берёт его через PAM.
sed -i '/^XDG_/d' /etc/environment
useradd --system --create-home --shell /usr/sbin/nologin zvonix
[ "$(sudo -u zvonix -H sh -c 'echo "$HOME:${XDG_CONFIG_HOME:-}"')" = /home/zvonix: ] \
  || { sudo -u zvonix -H env >&2; fail "sudo не задаёт окружение как на сервере"; }
# Те же пути, что ставит server-setup.sh: sudo и systemd не видят node и pnpm из каталога инструментов CI.
ln -sf "$(command -v node)" /usr/bin/node
ln -sf "$(command -v node)" /usr/local/bin/node
version="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "${REPO}/package.json")"
npm install -g --prefix /usr/local "pnpm@${version}" >/dev/null

step "Подпись выпуска"
ssh-keygen -q -t ed25519 -N '' -C check -f "${WORK}/key"
RELEASE_SIGNER="$(cut -d' ' -f1,2 "${WORK}/key.pub")"
printf 'deadbeef  zvonix-check.tgz\n' >"${WORK}/sums"
ssh-keygen -q -Y sign -f "${WORK}/key" -n "$RELEASE_NAMESPACE" "${WORK}/sums"
(verify_signature "${WORK}/sums") || fail "верная подпись отвергнута"
printf 'cafe  zvonix-check.tgz\n' >"${WORK}/sums"
if (verify_signature "${WORK}/sums") 2>/dev/null; then fail "подменённая сумма принята"; fi
rm -f "${WORK}/sums.sig"
if (verify_signature "${WORK}/sums") 2>/dev/null; then fail "сумма без подписи принята"; fi

step "Распаковка"
unpack_release "$ARCHIVE" check
release="$RELEASE_DIR"
foreign="$(find "$release" ! -user root | head -5)"
[ -z "$foreign" ] || fail "в выпуске есть файлы не root: ${foreign}"
writable="$(find "$release" -perm /022 ! -type l | head -5)"
[ -z "$writable" ] || fail "в выпуске есть файлы, открытые на запись: ${writable}"
for target in deploy/deploy.sh deploy/updater.py node/install.sh apps/api/dist/main.js node_modules; do
  if sudo -u zvonix test -w "${release}/${target}"; then fail "zvonix может писать в ${target}"; fi
done
[ -e "${release}/node_modules/.modules.yaml" ] || fail "зависимости не установлены"

step "Кэш кабинета"
standalone="${release}/apps/web/.next/standalone/apps/web"
[ -L "${standalone}/.next/cache" ] || fail ".next/cache не ссылка"
sudo -u zvonix touch "${standalone}/.next/cache/probe" || fail "кабинет не может писать в свой кэш"
rm -f "${WEB_CACHE}/$(basename "$release")/probe"

step "Старый выпуск отбирается у zvonix"
old="${RELEASES}/old"
mkdir -p "${old}/apps/web/.next/standalone/apps/web/.next/cache"
chown -R zvonix:zvonix "$old"
harden_release "$old"
[ "$(stat -c %U "${old}/apps/web")" = root ] || fail "старый выпуск остался у zvonix"
[ -L "${old}/apps/web/.next/standalone/apps/web/.next/cache" ] || fail "у старого выпуска кэш не вынесен"
rm -rf -- "$old"

step "Скрипт узла из выпуска"
env_file="${WORK}/env"
cat >"$env_file" <<ENV
NODE_ENV=production
DATABASE_URL=${TEST_DATABASE_URL:?}
REDIS_URL=${TEST_REDIS_URL:?}
SECRET_KEY=deploy-check-deploy-check-deploy-check
PUBLIC_BASE_URL=http://127.0.0.1:18000
ENV
chmod 0644 "$env_file"
chmod 0755 "$WORK"
sudo -u zvonix sh -c 'set -a; . "$1"; set +a; cd "$0/apps/api" && exec node dist/modules/nodes/node-script.js' \
  "$release" "$env_file" >"${WORK}/node-install.sh" || fail "скрипт узла не собран"
head -1 "${WORK}/node-install.sh" | grep -q '^#!' || fail "скрипт узла пуст или повреждён"
bash -n "${WORK}/node-install.sh" || fail "скрипт узла с ошибкой синтаксиса"

step "API из каталога root"
sudo -u zvonix sh -c 'set -a; . "$1"; set +a; export APP_HOST=127.0.0.1 APP_PORT=18000 SMPP_PORT=0 SMPP_TLS_PORT=0 RECORDINGS_DIR=/tmp/zvonix-check-rec SUPPORT_DIR=/tmp/zvonix-check-sup; cd "$0/apps/api" && exec node dist/main.js' \
  "$release" "$env_file" >"${WORK}/api.log" 2>&1 &
api=$!
up=0
for _ in $(seq 1 40); do
  if curl -fs --max-time 2 -o /dev/null http://127.0.0.1:18000/health/live; then
    up=1
    break
  fi
  kill -0 "$api" 2>/dev/null || break
  sleep 1
done
pkill -u zvonix -f 'dist/main.js' || true
wait "$api" 2>/dev/null || true
[ "$up" -eq 1 ] || { tail -20 "${WORK}/api.log" >&2; fail "API выпуска не запустился"; }

step "Кабинет настоящим юнитом"
ln -sfn "$release" /opt/zvonix/current
install -m 0644 "${release}/deploy/systemd/zvonix-web.service" /etc/systemd/system/
systemctl daemon-reload
systemctl start zvonix-web
up=0
for _ in $(seq 1 40); do
  if curl -fs --max-time 2 -o /dev/null http://127.0.0.1:3000/login; then
    up=1
    break
  fi
  sleep 1
done
journal="$(journalctl -u zvonix-web --no-pager -o cat)"
[ "$up" -eq 1 ] || { printf '%s\n' "$journal" | tail -20 >&2; fail "кабинет не запустился"; }
curl -fs --max-time 5 -o /dev/null http://127.0.0.1:3000/login || fail "кабинет перестал отвечать"
journal="$(journalctl -u zvonix-web --no-pager -o cat)"
if printf '%s\n' "$journal" | grep -E 'EROFS|EACCES'; then fail "кабинет пытается писать вне своего кэша"; fi

echo
echo "Проба выкладки пройдена."
