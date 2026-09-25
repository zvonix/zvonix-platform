#!/usr/bin/env bash
#
# Установка узла АТС Zvonix (ARCHITECTURE.md, «Сценарий: подключение узла»).
#
#   curl -fsSL https://cp.example.com/install.sh | sudo bash -s -- <токен>
#
# Токен одноразовый и живёт час (ADR-0019): команда попадает в историю оболочки,
# в переписку и в буфер обмена, поэтому постоянного ключа в ней быть не должно.
# Скрипт обменивает токен на постоянный ключ и подставляет его в конфигурацию.
#
# Этот файл — **шаблон**. Его отдаёт control plane по `GET /install.sh`, подставляя
# свой адрес, SIP-домен, параметры репозитория пакетов и **весь набор конфигурации
# узла** внутрь (ADR-0045, ADR-0051). Поэтому скрипт ничего не читает с диска: у него
# нет шага, на котором он может оказаться без своих файлов. Прежняя редакция читала `./conf` рядом с собой
# и в конвейере `curl | bash` не находила ничего — `$0` там равно `bash`.
#
# Целевая ОС — Ubuntu. Скрипт идемпотентен: повторный запуск с новым токеном
# перенастраивает узел, не ломая уже работающий.

set -euo pipefail

TOKEN="${1:-}"
CONTROL_PLANE="${ZVONIX_CONTROL_PLANE:-@@CONTROL_PLANE@@}"
# SIP-домен площадки: входит в a1-hash каждой учётной записи (docs/api/telephony.md),
# поэтому узел не выбирает его, а берёт у площадки (ADR-0051).
SIP_REALM="${ZVONIX_SIP_REALM:-@@SIP_REALM@@}"
PACKAGE_REPO="${ZVONIX_PACKAGE_REPO:-@@PACKAGE_REPO@@}"
PACKAGE_SUITE="${ZVONIX_PACKAGE_SUITE:-@@PACKAGE_SUITE@@}"
PACKAGE_KEY_FINGERPRINT="${ZVONIX_PACKAGE_KEY_FINGERPRINT:-@@PACKAGE_KEY_FINGERPRINT@@}"
CONF_DIR="${ZVONIX_CONF_DIR:-}"
STATE_DIR="${ZVONIX_STATE_DIR:-/var/lib/zvonix}"
KEYRING="/usr/share/keyrings/zvonix-packages.gpg"

# Control plane заменяет в этом файле **каждое** вхождение целой метки. Поэтому целая
# метка стоит только в присваиваниях выше, а проверки «не подставлено» и замена меток
# в шаблонах XML собирают её из частей: целая, она сама стала бы подставленным значением.
# Так и было до первого живого запуска (2026-09-22): проверка сравнивала адрес сам
# с собой и отказывала всегда, отпечаток ключа подписи не сверялся, а в конфигурацию
# FreeSWITCH вместо адреса площадки ушла бы метка.
MARK='@@'

die() {
  echo "Ошибка: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "не найдена команда $1"
}

# --- Проверки до любых изменений ---------------------------------------------
# И, что важнее, **до обмена токена**: он одноразовый, и проверка, выполненная после,
# стоит владельцу выпуска новой команды. Прежняя редакция объявляла это правило
# и нарушала его: наличие шаблонов выяснялось в самом конце (ADR-0045).

[ -n "$TOKEN" ] || die "не передан токен установки. Команду выдаёт панель управления"
[ "$(id -u)" -eq 0 ] || die "нужны права root: запускайте через sudo"
case "$CONTROL_PLANE" in
  "" | *"$MARK"*) die "адрес control plane не подставлен" ;;
esac
[[ "$SIP_REALM" =~ ^[a-z0-9.-]+$ ]] || die "SIP-домен площадки не подставлен или недопустим: «${SIP_REALM}»"
# Репозиторий нужен ровно затем, чтобы **поставить** FreeSWITCH. Если он уже стоит,
# ставить нечего, и требовать адрес значило бы не пускать на узел, которому он не нужен.
# Первый узел площадки поднимается именно так: FreeSWITCH на нём собран руками,
# а команда из панели его только регистрирует и настраивает.
if command -v freeswitch >/dev/null 2>&1; then
  NEED_PACKAGES=no
else
  NEED_PACKAGES=yes
  case "$PACKAGE_REPO" in
    "" | *"$MARK"*)
      die "FreeSWITCH не установлен, а репозиторий пакетов не задан. Задайте NODE_PACKAGE_REPO_URL на площадке или поставьте FreeSWITCH на этот сервер" ;;
  esac
  [ -n "$PACKAGE_SUITE" ] || die "не задан выпуск Ubuntu для репозитория пакетов"
fi

# Каталог конфигурации — тоже до обмена токена. Пакет кладёт её в `/etc/freeswitch`,
# а собранный из исходников FreeSWITCH держит под своим префиксом, например
# `/usr/local/freeswitch/etc/freeswitch`. Прежняя редакция знала только первый путь
# и на первом же узле площадки упала бы уже после регистрации, сжёгши токен.
if [ "$NEED_PACKAGES" = yes ]; then
  # Пакета ещё нет: каталог появится вместе с ним и там, где его кладёт пакет.
  CONF_DIR="${CONF_DIR:-/etc/freeswitch}"
else
  if [ -z "$CONF_DIR" ]; then
    # Префикс сборки выводится из пути к самому исполняемому файлу: `…/bin/freeswitch`.
    PREFIX_CONF="$(dirname "$(dirname "$(readlink -f "$(command -v freeswitch)")")")/etc/freeswitch"
    for candidate in /etc/freeswitch "$PREFIX_CONF"; do
      if [ -f "${candidate}/autoload_configs/modules.conf.xml" ]; then
        CONF_DIR="$candidate"
        break
      fi
    done
    [ -n "$CONF_DIR" ] \
      || die "FreeSWITCH установлен, но его конфигурация не найдена ни в /etc/freeswitch, ни в ${PREFIX_CONF}. Укажите каталог: … | sudo ZVONIX_CONF_DIR=<каталог> bash -s -- <токен>"
  fi
  [ -f "${CONF_DIR}/autoload_configs/modules.conf.xml" ] \
    || die "в ${CONF_DIR} нет autoload_configs/modules.conf.xml — это не каталог конфигурации FreeSWITCH"
  echo "Конфигурация FreeSWITCH: ${CONF_DIR}"
fi

require curl
require sed
require python3
require gpg
require apt-get
require install

ADDRESSES="$CONTROL_PLANE"
# Именно `if`, а не `&&`: при `set -e` цепочка, закончившаяся ложью, роняет скрипт,
# и узел, которому репозиторий не нужен, не установился бы вовсе.
if [ "$NEED_PACKAGES" = yes ]; then
  ADDRESSES="$ADDRESSES $PACKAGE_REPO"
fi
for address in $ADDRESSES; do
  case "$address" in
    https://*) ;;
    http://127.0.0.1*|http://localhost*)
      echo "ВНИМАНИЕ: ${address} по http. Допустимо только при локальной отладке:" >&2
      echo "          по этому каналу уходят секрет ключа и пакеты." >&2
      ;;
    *) die "адрес ${address} должен быть по https: по этому каналу уходят секрет и пакеты" ;;
  esac
done

HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
[ -n "$HOSTNAME_FQDN" ] || die "не удалось определить имя машины"

# --- Ключ подписи репозитория -------------------------------------------------
# Скачивается и проверяется **до** обмена токена: недоступный репозиторий — причина
# остановиться, и остановиться нужно раньше, чем сгорел токен.

if [ "$NEED_PACKAGES" = yes ]; then

echo "Проверка репозитория пакетов ${PACKAGE_REPO}"

KEY_TMP="$(mktemp)"
trap 'rm -f "$KEY_TMP"' EXIT

curl -fsSL --max-time 30 "${PACKAGE_REPO}/zvonix.gpg" -o "$KEY_TMP" \
  || die "не удалось скачать ключ подписи ${PACKAGE_REPO}/zvonix.gpg"

# Ключ принимается и в бронированном виде, и в двоичном: `--dearmor` над уже двоичным
# завершается ошибкой, и это не повод останавливать установку.
KEY_BIN="$(mktemp)"
trap 'rm -f "$KEY_TMP" "$KEY_BIN"' EXIT
if gpg --dearmor < "$KEY_TMP" > "$KEY_BIN" 2>/dev/null && [ -s "$KEY_BIN" ]; then
  :
else
  cp "$KEY_TMP" "$KEY_BIN"
fi

if [ -n "$PACKAGE_KEY_FINGERPRINT" ] && [[ "$PACKAGE_KEY_FINGERPRINT" != *"$MARK"* ]]; then
  EXPECTED="$(echo "$PACKAGE_KEY_FINGERPRINT" | tr -d ' :' | tr '[:lower:]' '[:upper:]')"
  ACTUAL="$(gpg --show-keys --with-colons "$KEY_BIN" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')"
  [ -n "$ACTUAL" ] || die "не удалось прочитать отпечаток скачанного ключа подписи"
  [ "$ACTUAL" = "$EXPECTED" ] \
    || die "отпечаток ключа подписи не совпал: ожидался ${EXPECTED}, получен ${ACTUAL}"
  echo "Отпечаток ключа подписи совпал"
else
  # Отсутствие отпечатка не глушится молча: без него доверие держится только на TLS
  # до нашего же сервера, и это осознанно более слабая проверка.
  echo "ВНИМАНИЕ: отпечаток ключа подписи не задан — ключ принят по доверию к TLS." >&2
  echo "          Задайте NODE_PACKAGE_KEY_FINGERPRINT на площадке." >&2
fi

else
  echo "FreeSWITCH уже установлен — репозиторий пакетов не нужен"
fi

# --- Обмен токена на постоянный ключ -----------------------------------------
# Первое необратимое действие скрипта. После него не остаётся ни одной причины
# остановиться, кроме отказа внешней системы.

echo "Регистрация узла ${HOSTNAME_FQDN} в ${CONTROL_PLANE}"

ENROLL_BODY="$(
  curl -fsSL --max-time 30 \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"hostname\":\"${HOSTNAME_FQDN}\",\"agentVersion\":\"install.sh\"}" \
    "${CONTROL_PLANE}/node/enroll"
)" || die "регистрация не удалась. Токен одноразовый и живёт час — выпустите команду заново"

read_field() {
  echo "$ENROLL_BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
node = data
for part in sys.argv[1].split('.'):
    node = node[part]
print(node)
" "$1"
}

KEY_ID="$(read_field 'key.key_id')" || die "в ответе регистрации нет идентификатора ключа"
KEY_SECRET="$(read_field 'key.secret')" || die "в ответе регистрации нет секрета ключа"
NODE_NAME="$(read_field 'node.name')" || die "в ответе регистрации нет имени узла"

echo "Узел «${NODE_NAME}» зарегистрирован, ключ ${KEY_ID}"

# --- Репозиторий пакетов и установка FreeSWITCH -------------------------------
# Свой репозиторий, а не чужой (ADR-0045): в репозиториях Ubuntu пакета нет,
# а раздача SignalWire требует их токена и ставит подъём узла в зависимость
# от доступности постороннего сайта.

if [ "$NEED_PACKAGES" = yes ]; then
  install -d -m 0755 "$(dirname "$KEYRING")"
  install -m 0644 "$KEY_BIN" "$KEYRING"

  install -d -m 0755 /etc/apt/sources.list.d
  printf 'deb [signed-by=%s] %s %s main\n' "$KEYRING" "$PACKAGE_REPO" "$PACKAGE_SUITE" \
    > /etc/apt/sources.list.d/zvonix.list
  chmod 0644 /etc/apt/sources.list.d/zvonix.list

  echo "Установка FreeSWITCH из ${PACKAGE_REPO}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq freeswitch freeswitch-mod-sofia freeswitch-mod-xml-curl \
    freeswitch-mod-json-cdr freeswitch-mod-commands freeswitch-mod-dptools \
    freeswitch-mod-sndfile freeswitch-mod-event-socket
fi

# --- Конфигурация (ADR-0051) --------------------------------------------------
# Узел получает **свой набор целиком**, а не дописку в штатный. Штатный набор
# FreeSWITCH — демонстрационный: 24 пользователя с паролем 1234, контекст default,
# принимающий вызовы, ESL на всех адресах с ClueCon. С ним на узел за полчаса вошли
# сканеры (2026-09-22). Что в наборе не описано, того на узле нет.

install -d -m 0750 "$STATE_DIR" "${STATE_DIR}/cdr-failed" "${STATE_DIR}/rec"

# Секреты попадают в файлы конфигурации — так FreeSWITCH умеет аутентифицироваться
# (ADR-0019). Права закрываются сразу: кто получил root на узле, получил и ключ,
# но остальным его видеть незачем.
umask 077

# Пароль ESL порождается здесь при первой установке и лежит в /etc/fs_cli.conf
# (только root): оттуда его берёт fs_cli, и повторная установка его не меняет.
FS_CLI_CONF=/etc/fs_cli.conf
ESL_PASSWORD=""
if [ -f "$FS_CLI_CONF" ]; then
  ESL_PASSWORD="$(sed -n 's/^password => //p' "$FS_CLI_CONF" | head -1)"
fi
if [[ ! "$ESL_PASSWORD" =~ ^[0-9a-f]{32,}$ ]]; then
  ESL_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(24))')"
  printf '[default]\nhost => 127.0.0.1\nport => 8021\npassword => %s\n' "$ESL_PASSWORD" >"$FS_CLI_CONF"
fi
chmod 0600 "$FS_CLI_CONF"

# Набор собирается рядом с каталогом конфигурации — на той же файловой системе,
# чтобы подмена была переименованием, а не копированием.
STAGE="${CONF_DIR}.zvonix-new"
rm -rf "$STAGE"
install -d -m 0750 "$STAGE"

conf_file() {
  install -d -m 0750 "${STAGE}/$(dirname "$1")"
  cat >"${STAGE}/$1"
}

# Файлы набора вложил control plane, отдавая скрипт: читать с диска нечего.
stage_conf() {
@@CONF_FILES@@
}

stage_conf
# Транки к партнёрам по SIP собирает агент узла сюда (ADR-0039); пока агента нет, пусто.
install -d -m 0750 "${STAGE}/zvonix-gateways"

find "$STAGE" -type f -name '*.xml' -exec sed -i \
  -e "s|${MARK}CONTROL_PLANE${MARK}|${CONTROL_PLANE}|g" \
  -e "s|${MARK}SIP_REALM${MARK}|${SIP_REALM}|g" \
  -e "s|${MARK}KEY_ID${MARK}|${KEY_ID}|g" \
  -e "s|${MARK}KEY_SECRET${MARK}|${KEY_SECRET}|g" \
  -e "s|${MARK}ESL_PASSWORD${MARK}|${ESL_PASSWORD}|g" \
  {} +
if grep -rqE "${MARK}[A-Z_]+${MARK}" "$STAGE"; then
  die "в наборе конфигурации остались незаполненные метки: $(grep -rlE "${MARK}[A-Z_]+${MARK}" "$STAGE" | tr '\n' ' ')"
fi

# Прежний каталог не удаляется, а откладывается: штатный — один раз, в .before-zvonix,
# прежний наш — в .previous. Есть с чем сравнить и куда откатиться.
if [ -e "$CONF_DIR" ]; then
  if [ ! -e "${CONF_DIR}.before-zvonix" ]; then
    mv "$CONF_DIR" "${CONF_DIR}.before-zvonix"
  else
    rm -rf "${CONF_DIR}.previous"
    mv "$CONF_DIR" "${CONF_DIR}.previous"
  fi
fi
mv "$STAGE" "$CONF_DIR"
chown -R freeswitch:freeswitch "$STATE_DIR" "$CONF_DIR"
echo "Конфигурация FreeSWITCH заменена набором площадки: ${CONF_DIR}"

# --- Запуск ------------------------------------------------------------------

systemctl enable freeswitch >/dev/null 2>&1 || true
systemctl restart freeswitch

for attempt in $(seq 1 30); do
  fs_cli -p "$ESL_PASSWORD" -x status >/dev/null 2>&1 && break
  sleep 1
done
# Состояние — из общего списка профилей: `sofia status profile zvonix` показывает
# настройки профиля, а слова RUNNING в нём нет (проверено на живом узле 2026-09-22).
fs_cli -p "$ESL_PASSWORD" -x "sofia status" 2>/dev/null | grep -qE '^[[:space:]]*zvonix[[:space:]]+profile[[:space:]].*RUNNING' \
  || die "профиль SIP zvonix не поднялся — journalctl -u freeswitch и журнал FreeSWITCH"

# --- Защита от подбора паролей SIP (ADR-0051, ревизия) -----------------------
# Каждая неудачная попытка регистрации — это запрос учётной записи у площадки. Один
# сканер давал больше сотни попыток в секунду и занимал половину процессора API:
# способ положить площадку, не трогая её саму (замер на живом узле 2026-09-22).

fail2ban_file() {
  install -d -m 0755 "/etc/fail2ban/$(dirname "$1")"
  cat >"/etc/fail2ban/$1"
  chmod 0644 "/etc/fail2ban/$1"
}

if ! command -v fail2ban-client >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq fail2ban python3-systemd \
    || echo "ВНИМАНИЕ: fail2ban не установился — подбор паролей SIP никто не остановит" >&2
fi

if command -v fail2ban-client >/dev/null 2>&1; then
  # Каталог журнала — у самого FreeSWITCH: у сборки из исходников он под её префиксом.
  FREESWITCH_LOG="$(fs_cli -p "$ESL_PASSWORD" -x 'global_getvar log_dir' 2>/dev/null)/freeswitch.log"
  if [ -f "$FREESWITCH_LOG" ]; then
@@FAIL2BAN_FILES@@
    sed -i "s|${MARK}FREESWITCH_LOG${MARK}|${FREESWITCH_LOG}|" /etc/fail2ban/jail.d/zvonix-freeswitch.conf
    systemctl enable fail2ban >/dev/null 2>&1 || true
    systemctl restart fail2ban
    for attempt in $(seq 1 15); do
      fail2ban-client ping >/dev/null 2>&1 && break
      sleep 1
    done
    # Две тюрьмы (ревизия 2026-09-25): чужие логины — сканеры, логины площадки — шлюз
    # партнёра со старым паролем, его блокирует только поток уровня атаки.
    for jail in zvonix-freeswitch zvonix-freeswitch-known; do
      fail2ban-client status "$jail" >/dev/null 2>&1 \
        || echo "ВНИМАНИЕ: тюрьма $jail не поднялась — journalctl -u fail2ban" >&2
    done
    echo "Подбор паролей SIP закрывается на порту 5060: чужие логины — 5 неудач за час, блок на сутки; свои — 1200 за 10 минут, блок на час"
  else
    echo "ВНИМАНИЕ: журнал FreeSWITCH не найден (${FREESWITCH_LOG}) — защита от подбора паролей SIP не включена" >&2
  fi
fi

# --- Пароль ESL площадке (ADR-0055) -------------------------------------------
# С ним площадка сама звонит с выбранной SIM — тестовый звонок партнёра. Принимается
# только от узла на той же машине: ESL слушает 127.0.0.1. Отказ не роняет установку —
# звонки клиентов идут и без него.
# Секреты не попадают в аргументы процесса (их видно в ps): ключ — через конфигурацию
# curl на стандартном входе, тело — через файл, доступный только root.

ESL_BODY="$(umask 077 && mktemp)"
printf '{"password":"%s"}' "$ESL_PASSWORD" >"$ESL_BODY"
if printf 'user = "%s:%s"\n' "$KEY_ID" "$KEY_SECRET" \
  | curl -fsS --max-time 30 -K - -X PUT -H 'Content-Type: application/json' \
    --data-binary "@${ESL_BODY}" "${CONTROL_PLANE}/node/esl" >/dev/null; then
  echo "Тестовый звонок с SIM доступен: площадка знает пароль ESL узла"
else
  echo "ВНИМАНИЕ: площадка не приняла пароль ESL — тестовый звонок с SIM на этом узле недоступен (узел на другой машине или площадка не ответила)" >&2
fi
rm -f "$ESL_BODY"

# --- Пульс узла (docs/api/node.md, POST /node/heartbeat) ----------------------
# Раз в 30 секунд: число звонков и поднят ли профиль SIP. По пульсу площадка ставит
# узлу «работает» и снимает замолчавший. Агента узла из ADR-0019 пока нет — до него
# пульс шлёт таймер systemd; без пульса узел навсегда оставался «ставится» (2026-09-25).
# Ключ — в файле только для root, в аргументы процесса не попадает.

FS_CLI="$(command -v fs_cli)" || die "fs_cli не найден — пульсу нечем спрашивать FreeSWITCH"
install -d -m 0700 /etc/zvonix-node
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/heartbeat"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >/etc/zvonix-node/heartbeat.curl )

cat >/usr/local/sbin/zvonix-heartbeat <<HEARTBEAT
#!/bin/sh
# Пульс узла Zvonix — порождается node/install.sh, правится там.
set -u
CALLS="\$("${FS_CLI}" -x 'show calls count' 2>/dev/null | sed -n 's/^\([0-9][0-9]*\) total.*/\1/p' | head -1)"
DEGRADED=false
# FreeSWITCH не ответил — узел жив, но звонить не может: так и сообщаем.
[ -n "\$CALLS" ] || { CALLS=0; DEGRADED=true; }
"${FS_CLI}" -x 'sofia status' 2>/dev/null \\
  | grep -qE '^[[:space:]]*zvonix[[:space:]]+profile[[:space:]].*RUNNING' || DEGRADED=true
printf '{"activeCalls":%s,"degraded":%s,"agentVersion":"heartbeat.sh"}' "\$CALLS" "\$DEGRADED" \\
  | curl -fsS --max-time 10 -K /etc/zvonix-node/heartbeat.curl \\
      -H 'Content-Type: application/json' --data-binary @- >/dev/null
HEARTBEAT
chmod 0700 /usr/local/sbin/zvonix-heartbeat

cat >/etc/systemd/system/zvonix-heartbeat.service <<'UNIT'
[Unit]
Description=Пульс узла Zvonix площадке
After=network-online.target freeswitch.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zvonix-heartbeat
UNIT

cat >/etc/systemd/system/zvonix-heartbeat.timer <<'UNIT'
[Unit]
Description=Пульс узла Zvonix раз в 30 секунд

[Timer]
OnBootSec=15s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now zvonix-heartbeat.timer >/dev/null 2>&1
if /usr/local/sbin/zvonix-heartbeat; then
  echo "Пульс узла идёт: площадка видит узел «работает»"
else
  echo "ВНИМАНИЕ: площадка не приняла пульс узла — узел останется «ставится» (journalctl -u zvonix-heartbeat)" >&2
fi

echo
echo "Готово. Узел «${NODE_NAME}» настроен, профиль SIP zvonix работает."
echo
echo "Проверить, что ключ принимается с этого адреса:"
echo "  curl -fsS -u '${KEY_ID}:<секрет>' ${CONTROL_PLANE}/machine/self"
echo
echo "Секрет ключа лежит в ${CONF_DIR}/autoload_configs/xml_curl.conf.xml и больше"
echo "нигде не показывается: control plane хранит только его хеш."
