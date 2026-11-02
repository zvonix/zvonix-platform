#!/usr/bin/env bash
# Проба выкладки на настоящей Ubuntu (ADR-0109, ADR-0110): только CI, от root — запускать на рабочей машине нельзя.
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
trap 'systemctl stop "zvonix-api@*" "zvonix-web@*" zvonix-api zvonix-web zvonix-worker 2>/dev/null || true; rm -rf "$WORK"' EXIT

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

step "Функции выкладки целиком"
# Все функции и постоянные deploy.sh — кроме разбора аргументов внизу; часть постоянных ниже ужимается под пробу.
eval "$(awk '
  /^[a-z_]+\(\) \{.*\}$/ { print; next }
  /^[a-z_]+\(\) \{/ { inside = 1 }
  inside { print; if ($0 ~ /^\}/) inside = 0; next }
  /^[A-Z_]+=/ && !/^ARGS=/ { print }
' "$DEPLOY")"
RELEASES=/opt/zvonix/releases
WATCH_SECONDS=20
STABLE_SECONDS=2
WORK="$(mktemp -d)"

step "Площадка до экземпляров"
command -v nginx >/dev/null || apt-get install -y -qq nginx >/dev/null
rm -f /etc/nginx/sites-enabled/default
systemctl start nginx
install -d -m 0755 /etc/zvonix
cp "$env_file" /etc/zvonix/zvonix.env
chmod 0640 /etc/zvonix/zvonix.env
chgrp zvonix /etc/zvonix/zvonix.env
first="$release"
second="${RELEASES}/check-second"
cp -a "$first" "$second"
web_cache "$second"
point "$CURRENT" "$first"
# Прежние службы — как их ставили выпуски до ADR-0110: один экземпляр на 8000 и 3000.
cat >/etc/systemd/system/zvonix-api.service <<UNIT
[Service]
User=zvonix
WorkingDirectory=/opt/zvonix/current/apps/api
EnvironmentFile=/etc/zvonix/zvonix.env
Environment=RECORDINGS_DIR=/tmp/zvonix-check-rec SUPPORT_DIR=/tmp/zvonix-check-sup SMPP_PORT=0
ExecStart=/usr/bin/node dist/main.js
UNIT
cat >/etc/systemd/system/zvonix-web.service <<UNIT
[Service]
User=zvonix
WorkingDirectory=/opt/zvonix/current/apps/web/.next/standalone/apps/web
Environment=NODE_ENV=production HOSTNAME=127.0.0.1 PORT=3000
ExecStart=/usr/bin/node server.js
UNIT
# Воркер и экземпляры — настоящими юнитами выпуска; SMPP в пробе не нужен.
install_system_files "$first"
printf 'SMPP_PORT=0\n' >>/etc/zvonix/zvonix.env
systemctl daemon-reload
systemctl start zvonix-api zvonix-web
wait_ready "$API_READY" && wait_ready "$WEB_READY" || fail "прежние службы не поднялись"

# Непрерывные запросы к постоянным адресам: каждый отказ — строка в файле.
probe_start() {
  : >"${WORK}/refused"
  (
    while [ ! -f "${WORK}/stop-probe" ]; do
      curl -fs --max-time 3 -o /dev/null "$API_READY" || echo "api $(date +%T.%N)" >>"${WORK}/refused"
      curl -fs --max-time 3 -o /dev/null "$WEB_READY" || echo "web $(date +%T.%N)" >>"${WORK}/refused"
      sleep 0.2
    done
  ) &
  PROBE=$!
}
probe_stop() {
  touch "${WORK}/stop-probe"
  wait "$PROBE" 2>/dev/null || true
  rm -f "${WORK}/stop-probe"
}

step "Переход на экземпляры"
activate "$second" "$first" || fail "переход с одного экземпляра не удался"
[ "$(active_slot)" = a ] || fail "после перехода активен не «a»"
legacy_running && fail "прежние службы остались"
[ "$(readlink -f "$CURRENT")" = "$second" ] || fail "current не на новом выпуске"

step "Обновление без простоя"
probe_start
activate "$first" "$second" || { probe_stop; fail "обновление не удалось"; }
probe_stop
[ ! -s "${WORK}/refused" ] || { cat "${WORK}/refused" >&2; fail "во время обновления были отказы"; }
[ "$(active_slot)" = b ] || fail "после обновления активен не «b»"
systemctl is-active --quiet zvonix-api@a && fail "прежний экземпляр не остановлен"

step "Прежний экземпляр дорабатывает соединения"
# Открытое соединение с портом экземпляра «a» держится 4 секунды: остановка ждёт его, а не обрывает.
DRAIN_SECONDS=30
systemctl start zvonix-api@a
wait_ready "http://127.0.0.1:$(api_port a)/health/live" || fail "экземпляр «a» для пробы не поднялся"
(
  exec 3<>"/dev/tcp/127.0.0.1/$(api_port a)"
  sleep 4
  exec 3>&-
) &
holder=$!
sleep 1
started="$(date +%s)"
drain_slot a
waited=$(($(date +%s) - started))
wait "$holder" 2>/dev/null || true
stop_slot a
[ "$waited" -ge 2 ] || fail "остановка не ждала открытого соединения (${waited} с)"
[ "$waited" -lt 30 ] || fail "ожидание не закончилось, когда соединение закрылось"
grep -q 'zvonix_slot' "$NGINX_SLOT" || fail "журнал постоянных адресов не настроен"
[ -s "$SLOT_LOG" ] || fail "журнал постоянных адресов пуст"

step "Выпуск, который не поднимается"
broken="${RELEASES}/check-broken"
cp -a "$first" "$broken"
printf 'process.exit(1);\n' >"${broken}/apps/api/dist/main.js"
web_cache "$broken"
probe_start
if activate "$broken" "$first"; then probe_stop; fail "сломанный выпуск принят"; fi
probe_stop
[ ! -s "${WORK}/refused" ] || { cat "${WORK}/refused" >&2; fail "сломанный выпуск вызвал отказы"; }
[ "$(active_slot)" = b ] || fail "после отказа активен не прежний «b»"
[ "$(readlink -f "$CURRENT")" = "$first" ] || fail "current сдвинулся на сломанный выпуск"

step "Выпуск, который падает в окне наблюдения"
dying="${RELEASES}/check-dying"
cp -a "$first" "$dying"
mv "${dying}/apps/api/dist/main.js" "${dying}/apps/api/dist/main-real.js"
# Поднимается и отвечает «готов», а через 8 секунд выходит с кодом 0 — systemd его не перезапустит.
printf "import './main-real.js';\nsetTimeout(() => process.exit(0), 8000);\n" >"${dying}/apps/api/dist/main.js"
web_cache "$dying"
if activate "$dying" "$first"; then fail "выпуск, упавший в окне, принят"; fi
[ "$(active_slot)" = b ] || fail "после сбоя в окне активен не прежний «b»"
[ "$(readlink -f "$CURRENT")" = "$first" ] || fail "current не вернулся на прежний выпуск"
wait_ready "$API_READY" && wait_ready "$WEB_READY" || fail "после возврата площадка не отвечает"
systemctl is-active --quiet zvonix-worker || fail "воркер не работает после возврата"

step "Кабинет пишет только в свой кэш"
journal="$(journalctl -u 'zvonix-web@*' --no-pager -o cat)"
if printf '%s\n' "$journal" | grep -E 'EROFS|EACCES'; then fail "кабинет пытается писать вне своего кэша"; fi

echo
echo "Проба выкладки пройдена."
