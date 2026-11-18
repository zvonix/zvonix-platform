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
#
# Обновление уже установленного узла — без токена (ADR-0051, ревизия 2026-09-29):
#
#   zvonix-node-update            (ставится этим скриптом; то же, что ниже)
#   curl -fsSL https://cp.example.com/install.sh | sudo bash -s -- --update
#
# Ключ узла уже лежит на машине, обменивать нечего. Набор конфигурации, правила
# fail2ban и пульс приводятся к тем, что в текущем выпуске площадки; FreeSWITCH
# перезапускается, только если набор изменился, и только когда на узле нет звонков.
# Выкладка площадки (`zvonix-deploy`) зовёт это сама, если узел на той же машине.

set -euo pipefail

MODE=install
TOKEN=""
if [ "${1:-}" = "--update" ]; then
  MODE=update
else
  TOKEN="${1:-}"
fi
CONTROL_PLANE="${ZVONIX_CONTROL_PLANE:-@@CONTROL_PLANE@@}"
# SIP-домен площадки: входит в a1-hash каждой учётной записи (docs/api/telephony.md),
# поэтому узел не выбирает его, а берёт у площадки (ADR-0051).
SIP_REALM="${ZVONIX_SIP_REALM:-@@SIP_REALM@@}"
PACKAGE_REPO="${ZVONIX_PACKAGE_REPO:-@@PACKAGE_REPO@@}"
PACKAGE_SUITE="${ZVONIX_PACKAGE_SUITE:-@@PACKAGE_SUITE@@}"
PACKAGE_KEY_FINGERPRINT="${ZVONIX_PACKAGE_KEY_FINGERPRINT:-@@PACKAGE_KEY_FINGERPRINT@@}"
CONF_DIR="${ZVONIX_CONF_DIR:-}"
# Версия этого набора: отпечаток скрипта, подставляет площадка (ADR-0068). Пишется на узел, когда набор
# применён целиком, и уходит в пульсе — по ней площадка видит, что узел отстаёт.
NODE_SET_VERSION="${ZVONIX_SET_VERSION:-@@SET_VERSION@@}"
STATE_DIR="${ZVONIX_STATE_DIR:-/var/lib/zvonix}"
KEYRING="/usr/share/keyrings/zvonix-packages.gpg"
# Что узел знает о себе: ключ и каталог конфигурации. Отсюда их берёт обновление.
NODE_ETC="${ZVONIX_NODE_ETC:-/etc/zvonix-node}"
NODE_ENV="${NODE_ETC}/node.env"
# Сколько обновление ждёт окончания звонков, прежде чем отложить перезапуск FreeSWITCH.
DRAIN_SECONDS="${ZVONIX_DRAIN_SECONDS:-600}"

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

[ "$(id -u)" -eq 0 ] || die "нужны права root: запускайте через sudo"

# Поле файла node.env: разбирается, а не исполняется — файл не становится кодом root.
node_env_field() {
  [ -f "$NODE_ENV" ] && sed -n "s/^$1=//p" "$NODE_ENV" | head -1
}

if [ "$MODE" = install ]; then
  [ -n "$TOKEN" ] || die "не передан токен установки. Команду выдаёт панель управления"
else
  command -v freeswitch >/dev/null 2>&1 \
    || die "FreeSWITCH не установлен — это не узел. Установите его командой из панели"
  KEY_ID="$(node_env_field KEY_ID || true)"
  KEY_SECRET="$(node_env_field KEY_SECRET || true)"
  # Узлы, поставленные до node.env, хранят ключ только в конфигурации пульса.
  if [ -z "$KEY_ID" ] && [ -f "${NODE_ETC}/heartbeat.curl" ]; then
    CREDENTIALS="$(sed -n 's/^user = "\([^"]*\)"$/\1/p' "${NODE_ETC}/heartbeat.curl" | head -1)"
    KEY_ID="${CREDENTIALS%%:*}"
    KEY_SECRET="${CREDENTIALS#*:}"
  fi
  [[ "$KEY_ID" =~ ^[A-Za-z0-9_-]+$ ]] && [[ "$KEY_SECRET" =~ ^[A-Za-z0-9_-]+$ ]] \
    || die "ключ узла на машине не найден (${NODE_ENV}) — установите узел заново командой из панели"
  CONF_DIR="${CONF_DIR:-$(node_env_field CONF_DIR || true)}"
  NODE_NAME="$(hostname -f 2>/dev/null || hostname)"
fi
case "$CONTROL_PLANE" in
  "" | *"$MARK"*) die "адрес control plane не подставлен" ;;
esac
[[ "$SIP_REALM" =~ ^[a-z0-9.-]+$ ]] || die "SIP-домен площадки не подставлен или недопустим: «${SIP_REALM}»"
# Обновление системы — до всего остального: на свежей машине обычно сотня пакетов с исправлениями безопасности, и
# ставить их после запуска телефонии значило бы перезагружать её посреди работы. Не перезагружаем сами: звонков ещё
# нет, но машина может быть не наша — о перезагрузке сказано в конце. Пропустить: ZVONIX_SKIP_UPGRADE=1.
if [ "$MODE" = install ] && [ "${ZVONIX_SKIP_UPGRADE:-}" != 1 ] && command -v apt-get >/dev/null 2>&1; then
  echo "Обновление пакетов системы (несколько минут)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq     && apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade     || echo "Справка: обновить пакеты системы не удалось — узел ставится дальше; выполните apt upgrade позже" >&2
fi

# Нет FreeSWITCH и нет репозитория пакетов — собираем из исходников скриптом площадки: так одна команда
# ставит узел на чистую машину целиком. Долго (полчаса–час), поэтому до обмена токена: токен не сгорает.
if ! command -v freeswitch >/dev/null 2>&1 && [ "$MODE" = install ]; then
  case "$PACKAGE_REPO" in
    "" | *"$MARK"*)
      command -v curl >/dev/null 2>&1 || die "не найдена команда curl"
      echo "Репозитория пакетов нет — собираю FreeSWITCH из исходников (30–60 минут, не прерывайте)"
      BUILD_TMP="$(mktemp)"
      curl -fsSL --max-time 60 "${CONTROL_PLANE}/install/build-freeswitch.sh" -o "$BUILD_TMP" \
        || die "не удалось скачать скрипт сборки ${CONTROL_PLANE}/install/build-freeswitch.sh"
      ZVONIX_NO_START=1 bash "$BUILD_TMP" || { rm -f "$BUILD_TMP"; die "сборка FreeSWITCH не удалась — журнал выше; после исправления запустите команду снова"; }
      rm -f "$BUILD_TMP"
      hash -r
      ;;
  esac
fi

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
# остановиться, кроме отказа внешней системы. Обновлению обменивать нечего: ключ
# уже на машине.

if [ "$MODE" = install ]; then

echo "Регистрация узла ${HOSTNAME_FQDN} в ${CONTROL_PLANE}"

# Без -f: при отказе площадка называет причину в теле ответа, и показать её — единственный способ не гадать.
ENROLL_BODY="$(
  curl -sSL --max-time 30 -w '\n%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"hostname\":\"${HOSTNAME_FQDN}\",\"agentVersion\":\"install.sh\"}" \
    "${CONTROL_PLANE}/node/enroll"
)" || die "площадка не ответила на регистрацию — проверьте сеть и адрес ${CONTROL_PLANE}"
ENROLL_CODE="${ENROLL_BODY##*$'\n'}"
ENROLL_BODY="${ENROLL_BODY%$'\n'*}"
if [ "$ENROLL_CODE" != 200 ] && [ "$ENROLL_CODE" != 201 ]; then
  ENROLL_REASON="$(printf '%s' "$ENROLL_BODY" | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | head -1)"
  die "регистрация не удалась (код ${ENROLL_CODE}): ${ENROLL_REASON:-без пояснения}. Если токен уже применён или просрочен — выпустите команду заново"
fi

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

fi

# Ключ и каталог конфигурации — туда, откуда их возьмёт обновление. Только root:
# это тот же секрет, что лежит в конфигурации FreeSWITCH.
install -d -m 0700 "$NODE_ETC"
( umask 077 && printf 'KEY_ID=%s\nKEY_SECRET=%s\nCONF_DIR=%s\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONF_DIR" >"${NODE_ENV}.new" && mv -f "${NODE_ENV}.new" "$NODE_ENV" )

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
# Транки к партнёрам по SIP (ADR-0039) кладёт сюда пульс узла (ADR-0118); при обновлении каталог переносится.
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

# --- Подмена набора и перезапуск ---------------------------------------------

# Состояние профиля — из общего списка профилей: `sofia status profile zvonix` показывает
# настройки профиля, а слова RUNNING в нём нет (проверено на живом узле 2026-09-22).
profile_running() {
  fs_cli -p "$ESL_PASSWORD" -x "sofia status" 2>/dev/null \
    | grep -qE '^[[:space:]]*zvonix[[:space:]]+profile[[:space:]].*RUNNING'
}

# Перезапуск с ожиданием ответа ESL и профиля SIP.
restart_freeswitch() {
  systemctl enable freeswitch >/dev/null 2>&1 || true
  systemctl restart freeswitch
  for attempt in $(seq 1 30); do
    fs_cli -p "$ESL_PASSWORD" -x status >/dev/null 2>&1 && break
    sleep 1
  done
  # Профиль поднимается чуть позже ESL: несколько секунд на привязку порта.
  for attempt in $(seq 1 10); do
    profile_running && return 0
    sleep 1
  done
  return 1
}

# Число звонков на узле; пусто — FreeSWITCH не ответил.
active_calls() {
  fs_cli -p "$ESL_PASSWORD" -x 'show calls count' 2>/dev/null \
    | sed -n 's/^\([0-9][0-9]*\) total.*/\1/p' | head -1
}

# Ждёт, пока на узле не останется звонков: перезапуск FreeSWITCH рвёт каждый идущий
# разговор, а обновление приходит посреди рабочего дня вместе с выпуском площадки.
wait_idle() {
  local waited=0 calls
  while :; do
    calls="$(active_calls)"
    [ -z "$calls" ] || [ "$calls" -eq 0 ] && return 0
    [ "$waited" -ge "$DRAIN_SECONDS" ] && return 1
    [ $((waited % 60)) -eq 0 ] && echo "На узле идут звонки (${calls}) — жду их окончания перед перезапуском FreeSWITCH"
    sleep 5
    waited=$((waited + 5))
  done
}

# Набор сравнивается с действующим: не изменился — FreeSWITCH не трогается вовсе.
# Не наше и в сравнение не входит: каталог транков агента узла (ADR-0039) и `tls/` —
# сертификаты, которые FreeSWITCH порождает сам при запуске (живой узел, 2026-09-29:
# без исключения каждое обновление видело отличие и перезапускало узел).
UNOWNED_DIRS="zvonix-gateways tls"
CONF_POSTPONED=no
if [ -d "$CONF_DIR" ] && diff -rq --exclude=zvonix-gateways --exclude=tls "$STAGE" "$CONF_DIR" >/dev/null 2>&1; then
  rm -rf "$STAGE"
  echo "Конфигурация FreeSWITCH не изменилась: ${CONF_DIR}"
  if ! profile_running; then
    restart_freeswitch || die "профиль SIP zvonix не поднялся — journalctl -u freeswitch и журнал FreeSWITCH"
  fi
elif [ "$MODE" = update ] && ! wait_idle; then
  # Звонки не кончились — конфигурация ждёт следующего запуска, а не рвёт разговоры.
  rm -rf "$STAGE"
  CONF_POSTPONED=yes
  echo "ВНИМАНИЕ: звонки шли дольше ${DRAIN_SECONDS} с — новая конфигурация FreeSWITCH не применена. Повторите zvonix-node-update в тихое время" >&2
else
  # Транки агента и сертификаты FreeSWITCH переезжают в новый набор, иначе подмена
  # стёрла бы их.
  for unowned in $UNOWNED_DIRS; do
    if [ -d "${CONF_DIR}/${unowned}" ]; then
      rm -rf "${STAGE:?}/${unowned}"
      cp -a "${CONF_DIR}/${unowned}" "${STAGE}/${unowned}"
    fi
  done
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

  if ! restart_freeswitch; then
    # Работавший узел не оставляется лежать: прежний набор возвращается. При первой
    # установке возвращать нечего — прежним был демонстрационный набор.
    if [ "$MODE" = update ] && [ -d "${CONF_DIR}.previous" ]; then
      rm -rf "${CONF_DIR}.failed"
      mv "$CONF_DIR" "${CONF_DIR}.failed"
      mv "${CONF_DIR}.previous" "$CONF_DIR"
      restart_freeswitch || true
      die "с новой конфигурацией профиль SIP zvonix не поднялся — возвращена прежняя, новая лежит в ${CONF_DIR}.failed"
    fi
    die "профиль SIP zvonix не поднялся — journalctl -u freeswitch и журнал FreeSWITCH"
  fi
fi

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
    # Адреса, которые SSH не блокирует (свои офис и дом): только цифры, точки, двоеточия, слеши и пробелы.
    ALLOW_IPS_RE='^[0-9a-fA-F.:/ ]+$'
    if [ -n "${ZVONIX_SSH_ALLOW_IPS:-}" ] && [[ "$ZVONIX_SSH_ALLOW_IPS" =~ $ALLOW_IPS_RE ]]; then
      printf 'ignoreip = 127.0.0.1/8 ::1 %s
' "$ZVONIX_SSH_ALLOW_IPS" >>/etc/fail2ban/jail.d/zvonix-sshd.conf
    fi
    systemctl enable fail2ban >/dev/null 2>&1 || true
    # Работающий fail2ban перечитывает правила, не снимая блокировок; стоящий — запускается.
    if fail2ban-client ping >/dev/null 2>&1; then
      fail2ban-client reload >/dev/null
    else
      systemctl restart fail2ban
    fi
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

# --- Укрепление сервера: файрвол, сеть, SSH ---------------------------------
# Узел стоит на открытом адресе, и за час на него приходят сотни попыток входа. Ставится только при установке
# (не при обновлении набора): правила сервера — не часть набора конфигурации. Пропустить: ZVONIX_SKIP_HARDENING=1.
# Каждый шаг не роняет установку: узел работает и без него, а об отказе сказано в выводе.

harden_firewall() {
  command -v ufw >/dev/null 2>&1 || apt-get install -y -qq ufw >/dev/null 2>&1 \
    || { echo "ВНИМАНИЕ: ufw не установился — файрвол не включён" >&2; return 0; }
  # Порт SSH берётся из работающей конфигурации: ошибка здесь отрезала бы единственный доступ к машине.
  local ssh_ports
  ssh_ports="$(sshd -T 2>/dev/null | sed -n 's/^port //p')"
  [ -n "$ssh_ports" ] || ssh_ports=22
  local port
  for port in $ssh_ports; do
    ufw allow "${port}/tcp" comment 'SSH' >/dev/null
  done
  ufw allow 5060/udp comment 'SIP' >/dev/null
  ufw allow 5060/tcp comment 'SIP' >/dev/null
  ufw allow 16384:32768/udp comment 'RTP' >/dev/null
  # Исходящее разрешено, входящее — только перечисленное. Уже включённый ufw с чужими правилами не сбрасывается.
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
  echo "Файрвол включён: открыты SSH (${ssh_ports//$'\n'/, }), SIP 5060, RTP 16384–32768/UDP"
}

harden_network() {
  # Буферы по умолчанию (~200 КБ) на сотнях потоков RTP дают потерю пакетов — треск в разговоре.
  cat >/etc/sysctl.d/90-zvonix.conf <<'SYSCTL'
# Порождается node/install.sh — правится там.
net.core.rmem_max = 26214400
net.core.wmem_max = 26214400
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 5000
net.core.somaxconn = 4096
net.netfilter.nf_conntrack_max = 262144
SYSCTL
  # Модуль conntrack грузится файрволом позже, чем systemd-sysctl читает файл: без этого значение не применилось бы после перезагрузки.
  echo nf_conntrack >/etc/modules-load.d/zvonix-conntrack.conf
  modprobe nf_conntrack 2>/dev/null || true
  # Ключа conntrack нет, пока не загружен модуль: ошибка по нему — не повод считать шаг проваленным.
  sysctl -q -p /etc/sysctl.d/90-zvonix.conf >/dev/null 2>&1 || true
  echo "Сетевые буферы под нагрузку заданы (/etc/sysctl.d/90-zvonix.conf)"
}

harden_ssh() {
  # Ограничения попыток входа не зависят от ключей: безопасны всегда.
  install -d -m 0755 /etc/ssh/sshd_config.d
  cat >/etc/ssh/sshd_config.d/10-zvonix.conf <<'SSHD'
# Порождается node/install.sh — правится там.
MaxAuthTries 3
LoginGraceTime 30
SSHD
  # Пароли отключаются только когда есть чем войти: иначе машина осталась бы без доступа.
  local has_key=no key_file
  for key_file in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    if [ -s "$key_file" ] && grep -qE '^(ssh-|ecdsa-|sk-)' "$key_file" 2>/dev/null; then
      has_key=yes
      break
    fi
  done
  if [ "$has_key" = yes ]; then
    cat >>/etc/ssh/sshd_config.d/10-zvonix.conf <<'SSHD'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
SSHD
  else
    echo "Справка: ключей SSH на сервере нет — вход по паролю оставлен (пароли отключаются, когда в ~/.ssh/authorized_keys есть ключ; затем запустите команду снова)"
  fi
  if sshd -t 2>/dev/null; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    [ "$has_key" = yes ] && echo "SSH: вход только по ключу, пароли отключены"
  else
    rm -f /etc/ssh/sshd_config.d/10-zvonix.conf
    echo "ВНИМАНИЕ: конфигурация SSH не прошла проверку — прежняя оставлена" >&2
  fi
  return 0
}

if [ "${ZVONIX_SKIP_HARDENING:-}" = 1 ]; then
  echo "Укрепление сервера пропущено (ZVONIX_SKIP_HARDENING=1)"
elif [ "$MODE" = install ]; then
  harden_ssh
  harden_firewall
  harden_network
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
  echo "Площадка знает пароль ESL узла: команды узлу идут напрямую"
else
  echo "Справка: узел на отдельной машине — площадка не знает пароль ESL, команды узлу пойдут через службу команд (ниже)"
fi
rm -f "$ESL_BODY"

# --- Пульс узла (docs/api/node.md, POST /node/heartbeat) ----------------------
# Раз в 30 секунд: число звонков и поднят ли профиль SIP. По пульсу площадка ставит
# узлу «работает» и снимает замолчавший. Агента узла из ADR-0019 пока нет — до него
# пульс шлёт таймер systemd; без пульса узел навсегда оставался «ставится» (2026-09-25).
# Ключ — в файле только для root, в аргументы процесса не попадает.

FS_CLI="$(command -v fs_cli)" || die "fs_cli не найден — пульсу нечем спрашивать FreeSWITCH"
install -d -m 0700 "$NODE_ETC"
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/heartbeat"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >"${NODE_ETC}/heartbeat.curl" )
# Замер нагрузки, памяти и диска (ADR-0065, POST /node/metrics): тот же ключ, другой адрес.
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/metrics"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >"${NODE_ETC}/metrics.curl" )
# Кто вошёл на узел (ADR-0114, POST /node/registrations): тот же ключ, другой адрес.
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/registrations"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >"${NODE_ETC}/registrations.curl" )
# SIP-провайдеры партнёров (ADR-0118, GET /node/sip-gateways.xml): тот же ключ, другой адрес.
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/sip-gateways.xml"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >"${NODE_ETC}/sip-gateways.curl" )
# Доверенные адреса для fail2ban (ADR-0125, GET /node/trusted-addresses.txt): тот же ключ, другой адрес.
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/trusted-addresses.txt"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >"${NODE_ETC}/trusted-addresses.curl" )
# Связь с SIP-провайдерами (ADR-0121, POST /node/sip-gateways/status): тот же ключ, другой адрес.
( umask 077 && printf 'user = "%s:%s"\nurl = "%s/node/sip-gateways/status"\n' \
  "$KEY_ID" "$KEY_SECRET" "$CONTROL_PLANE" >"${NODE_ETC}/sip-gateways-status.curl" )

cat >/usr/local/sbin/zvonix-heartbeat <<HEARTBEAT
#!/bin/sh
# Пульс узла Zvonix — порождается node/install.sh, правится там.
set -u
CALLS="\$("${FS_CLI}" -x 'show calls count' 2>/dev/null | sed -n 's/^\([0-9][0-9]*\) total.*/\1/p' | head -1)"
DEGRADED=false
# FreeSWITCH не ответил — узел жив, но звонить не может: так и сообщаем.
[ -n "\$CALLS" ] || { CALLS=0; DEGRADED=true; }
# Замер сервера: нагрузка, память, диск. Не снялся — пульс всё равно идёт.
LOAD="\$(cut -d' ' -f1 /proc/loadavg 2>/dev/null)"
CORES="\$(nproc 2>/dev/null)"
MEMT="\$(awk '/^MemTotal:/ {print int(\$2/1024)}' /proc/meminfo 2>/dev/null)"
MEMA="\$(awk '/^MemAvailable:/ {print int(\$2/1024)}' /proc/meminfo 2>/dev/null)"
DISK="\$(df -Pm /var/lib 2>/dev/null | awk 'NR==2 {print \$2, \$4}')"
if [ -n "\$LOAD" ] && [ -n "\$CORES" ] && [ -n "\$MEMT" ] && [ -n "\$MEMA" ] && [ -n "\$DISK" ]; then
  printf '{"load1":%s,"cpuCores":%s,"memTotalMb":%s,"memAvailableMb":%s,"diskTotalMb":%s,"diskFreeMb":%s,"activeCalls":%s}' \\
    "\$LOAD" "\$CORES" "\$MEMT" "\$MEMA" "\${DISK% *}" "\${DISK#* }" "\$CALLS" \\
    | curl -fsS --max-time 10 -K "${NODE_ETC}/metrics.curl" \\
        -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true
fi
"${FS_CLI}" -x 'sofia status' 2>/dev/null \\
  | grep -qE '^[[:space:]]*zvonix[[:space:]]+profile[[:space:]].*RUNNING' || DEGRADED=true
# SIP-провайдеры партнёров (ADR-0118): площадка отдаёт готовый файл sofia-gateway, по транку на строку.
# Изменился — пропавшие и изменённые транки снимаются (killgw), профиль перечитывает остальное
# (reloadxml + rescan) без перезапуска и без обрыва разговоров. Площадка недоступна или ответ
# не похож на файл — прежний остаётся как есть: провайдеры не пропадают из-за сбоя связи.
GW_FILE="${CONF_DIR}/zvonix-gateways/zvonix.xml"
GW_NEW="${NODE_ETC}/sip-gateways.new"
if curl -fsS --max-time 10 -K "${NODE_ETC}/sip-gateways.curl" -o "\$GW_NEW" 2>/dev/null \\
  && [ "\$(head -n 1 "\$GW_NEW")" = '<include>' ] && [ "\$(tail -n 1 "\$GW_NEW")" = '</include>' ]; then
  if ! cmp -s "\$GW_NEW" "\$GW_FILE"; then
    if [ -f "\$GW_FILE" ]; then
      grep '^<gateway ' "\$GW_FILE" | while IFS= read -r LINE; do
        grep -qxF -- "\$LINE" "\$GW_NEW" && continue
        NAME="\$(printf '%s' "\$LINE" | sed -n 's/^<gateway name="\([A-Za-z0-9._-]*\)".*/\1/p')"
        [ -n "\$NAME" ] && "${FS_CLI}" -x "sofia profile zvonix killgw \$NAME" >/dev/null 2>&1
      done
      # Снятый gateway удаляется фоновым проходом sofia, а не сразу; rescan до него счёл бы
      # изменённый транк уже существующим и оставил прежние настройки.
      sleep 3
    fi
    install -d -m 0750 "\$(dirname "\$GW_FILE")"
    chown freeswitch:freeswitch "\$GW_NEW" "\$(dirname "\$GW_FILE")" 2>/dev/null || true
    chmod 0640 "\$GW_NEW"
    mv -f "\$GW_NEW" "\$GW_FILE"
    "${FS_CLI}" -x 'reloadxml' >/dev/null 2>&1
    "${FS_CLI}" -x 'sofia profile zvonix rescan' >/dev/null 2>&1
  fi
fi
rm -f "\$GW_NEW"
# Доверенные адреса (ADR-0125): откуда за неделю входили с верным паролем линии, шлюзы и линии GOIP. Они идут
# в ignoreip обеих SIP-тюрем: свой клиент не блокируется за таймаут каталога (18.11.2026 тюрьма чужих логинов
# закрыла живого клиента на сутки). Ответ без метки первой строкой или с чем-то кроме адресов — не применяется,
# прежний файл остаётся. Список не изменился — fail2ban не трогается; изменился — перечитываются только две
# SIP-тюрьмы (блокировки остаются), и с доверенных снимается блок, если он уже стоит.
TRUST_NEW="${NODE_ETC}/trusted-addresses.new"
TRUST_FILE=/etc/fail2ban/jail.d/zvonix-freeswitch-trusted.local
if command -v fail2ban-client >/dev/null 2>&1 \\
  && curl -fsS --max-time 10 -K "${NODE_ETC}/trusted-addresses.curl" -o "\$TRUST_NEW" 2>/dev/null \\
  && [ "\$(head -n 1 "\$TRUST_NEW")" = '# zvonix-trusted' ] \\
  && ! tail -n +2 "\$TRUST_NEW" | grep -qvE '^[0-9a-fA-F.:]{2,45}\$'; then
  TRUSTED="\$(tail -n +2 "\$TRUST_NEW" | tr '\n' ' ')"
  {
    echo '# Доверенные адреса площадки (ADR-0125) — пишет пульс узла из GET /node/trusted-addresses.txt.'
    echo '# Порождается node/install.sh, правится там; руками не править — перепишется через 30 секунд.'
    for JAIL in zvonix-freeswitch zvonix-freeswitch-known; do
      printf '[%s]\nignoreip = 127.0.0.1/8 ::1 %s\n' "\$JAIL" "\$TRUSTED"
    done
  } >"\$TRUST_NEW.local"
  if ! cmp -s "\$TRUST_NEW.local" "\$TRUST_FILE"; then
    install -m 0644 "\$TRUST_NEW.local" "\$TRUST_FILE"
    for JAIL in zvonix-freeswitch zvonix-freeswitch-known; do
      fail2ban-client reload "\$JAIL" >/dev/null 2>&1 || continue
      BANNED=" \$(fail2ban-client get "\$JAIL" banip 2>/dev/null | tr '\n' ' ') "
      for IP in \$TRUSTED; do
        case "\$BANNED" in
          *" \$IP "*) fail2ban-client set "\$JAIL" unbanip "\$IP" >/dev/null 2>&1 || true ;;
        esac
      done
    done
  fi
  rm -f "\$TRUST_NEW.local"
fi
rm -f "\$TRUST_NEW"
# Связь с провайдерами (ADR-0121): по каждому транку из файла — состояние регистрации и годность, как их видит
# sofia. Без этого «провайдер не принимает звонки» было видно только по GATEWAY_DOWN в отказах. В сообщение идут
# только имя, состояние, годность и код последнего отказа — ни адреса, ни учётных данных.
# FreeSWITCH не ответил — не шлём ничего.
if [ -f "\$GW_FILE" ]; then
  LINKS=""
  # Последний отказ регистрации — код ответа провайдера (403 — пароль, 404 — нет записи; 908 — провайдер не
  # ответил вовсе). sofia status его не показывает, а журнал пишет строкой «<имя> Failed Registration [<код>]»
  # (sofia_reg.c, REG_STATE_FAILED). Без кода «не на связи» не отличить «неверный пароль» от «нас не пускают».
  FS_LOG="\$("${FS_CLI}" -x 'global_getvar log_dir' 2>/dev/null | tr -d '\r\n')/freeswitch.log"
  REG_FAILS=""
  [ -r "\$FS_LOG" ] && REG_FAILS="\$(tail -n 20000 "\$FS_LOG" 2>/dev/null | grep -F ' Failed Registration [')"
  for NAME in \$(sed -n 's/^<gateway name="\([A-Za-z0-9._-]*\)".*/\1/p' "\$GW_FILE"); do
    GWS="\$("${FS_CLI}" -x "sofia status gateway \$NAME" 2>/dev/null)"
    ST="\$(printf '%s\n' "\$GWS" | awk '\$1=="State" {print \$2; exit}' | tr -cd 'A-Z_')"
    SS="\$(printf '%s\n' "\$GWS" | awk '\$1=="Status" {print \$2; exit}' | tr -cd 'A-Z_')"
    [ -n "\$ST" ] && [ -n "\$SS" ] || continue
    # Последний отказ: код и когда (ADR-0123). Время — начало строки журнала, по часам узла; date переводит его
    # в секунды эпохи с учётом пояса узла. Без времени площадка отказ показывает, но транк не останавливает.
    FL="\$(printf '%s\n' "\$REG_FAILS" | grep -F " \$NAME Failed Registration [" | tail -n 1)"
    FC="\$(printf '%s\n' "\$FL" | sed -n 's/.* Failed Registration \[\([0-9]\{3\}\)\].*/\1/p')"
    FA=""
    [ -n "\$FC" ] && FA="\$(date -d "\$(printf '%s\n' "\$FL" | awk '{print \$1" "\$2}')" +%s 2>/dev/null | tr -cd '0-9')"
    LINKS="\${LINKS}\${LINKS:+,}{\"name\":\"\$NAME\",\"state\":\"\$ST\",\"status\":\"\$SS\"\${FC:+,\"failure\":\$FC}\${FA:+,\"failure_at\":\$FA}}"
  done
  [ -n "\$LINKS" ] && printf '{"gateways":[%s]}' "\$LINKS" \
    | curl -fsS --max-time 10 -K "${NODE_ETC}/sip-gateways-status.curl" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true
fi
# Кто вошёл на узел (ADR-0114). Площадка ходит в ESL только на своей машине и об узле на отдельном
# сервере узнаёт лишь так; без этого вошедший GOIP в кабинете «не на связи». Поля url, token, hostname
# и metadata площадке не нужны — вырезаются, чтобы список влезал в предел тела. FreeSWITCH не ответил —
# не шлём ничего: отметки погаснут сами, как и положено у молчащего узла.
REGS="\$("${FS_CLI}" -x 'show registrations as json' 2>/dev/null | tr -d '\n' \\
  | sed -E 's/,"(url|token|hostname|metadata)":"[^"]*"//g')"
case "\$REGS" in
  '{'*) printf '%s' "\$REGS" | curl -fsS --max-time 10 -K "${NODE_ETC}/registrations.curl" \\
          -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 || true ;;
esac
# Версия набора на узле — ею площадка видит, отстаёт ли узел (ADR-0068). Файл пишет
# обновление, когда набор применён целиком; нет файла — узел версию не сообщает.
HAVE="\$(head -c 64 "${NODE_ETC}/set-version" 2>/dev/null | tr -cd '0-9a-f')"
if [ -n "\$HAVE" ]; then
  BODY="\$(printf '{"activeCalls":%s,"degraded":%s,"agentVersion":"heartbeat.sh","setVersion":"%s"}' "\$CALLS" "\$DEGRADED" "\$HAVE")"
else
  BODY="\$(printf '{"activeCalls":%s,"degraded":%s,"agentVersion":"heartbeat.sh"}' "\$CALLS" "\$DEGRADED")"
fi
REPLY="\$(printf '%s' "\$BODY" | curl -fsS --max-time 10 -K "${NODE_ETC}/heartbeat.curl" \\
  -H 'Content-Type: application/json' --data-binary @-)" || exit 1
# Автообновление (ADR-0068): площадка в ответе называет нужную версию набора и говорит, можно ли
# обновляться самому. Не чаще раза в полчаса; само обновление ждёт конца звонков и откладывается,
# если они не кончаются. Запускается отдельной единицей systemd, а не из пульса: пульс не ждёт.
if printf '%s' "\$REPLY" | grep -q '"auto_update":true'; then
  WANT="\$(printf '%s' "\$REPLY" | sed -n 's/.*"set_version":"\([0-9a-f]*\)".*/\1/p')"
  if [ -n "\$WANT" ] && [ "\$WANT" != "\$HAVE" ]; then
    STAMP="${NODE_ETC}/auto-update.stamp"
    NOW_TS="\$(date +%s)"
    LAST_TS="\$(cat "\$STAMP" 2>/dev/null || echo 0)"
    if [ \$((NOW_TS - LAST_TS)) -ge 1800 ]; then
      echo "\$NOW_TS" >"\$STAMP"
      systemd-run --quiet --no-block --collect --unit=zvonix-node-autoupdate \\
        /usr/local/sbin/zvonix-node-update >/dev/null 2>&1 || true
    fi
  fi
fi
exit 0
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

# --- Проверка связи с SIP-провайдером (ADR-0122) --------------------------------
# «Провайдер не отвечает» бывает и у провайдера, и в сети между узлом и им. Провайдер на это отвечает «подключений
# с вашего адреса не было» — и спорить не с чем. Проверка записывает трафик к адресам провайдера, сразу просит
# FreeSWITCH зарегистрироваться и считает: сколько запросов ушло, сколько ответов пришло, какой первый ответ.
# Запускает её только служба команд по команде площадки; имя транка — из файла sofia-gateway, адрес — оттуда же.
command -v tcpdump >/dev/null 2>&1 || apt-get install -y -qq tcpdump >/dev/null 2>&1 \
  || echo "ВНИМАНИЕ: tcpdump не установился — проверка связи с провайдером покажет только состояние" >&2

cat >/usr/local/sbin/zvonix-sip-check <<SIPCHECK_HEAD
#!/bin/sh
# Проверка связи узла с SIP-провайдером (ADR-0122) — порождается node/install.sh, правится там.
FS_CLI="${FS_CLI}"
GW_FILE="${CONF_DIR}/zvonix-gateways/zvonix.xml"
SIPCHECK_HEAD
cat >>/usr/local/sbin/zvonix-sip-check <<'SIPCHECK'
set -u
# Сколько слушать: FreeSWITCH повторяет REGISTER без ответа 0,5 → 1 → 2 → 4 с … до 32 с.
LISTEN=35
NAME="$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9._-')"
LINE="$(grep -F "<gateway name=\"$NAME\">" "$GW_FILE" 2>/dev/null | head -n 1)"
if [ -z "$NAME" ] || [ -z "$LINE" ]; then
  echo "ИТОГ: провайдера нет на узле — включите его и подождите минуту"
  exit 0
fi
PROXY="$(printf '%s' "$LINE" | sed -n 's/.*<param name="proxy" value="\([^"]*\)".*/\1/p')"
# Логин — чтобы считать пакеты только этой учётной записи (ADR-0123): у одного провайдера их бывает несколько, и
# адреса у них общие. Транк без регистрации узнаётся провайдером по адресу — его пакеты считаются по адресу.
USER=""
case "$LINE" in
  *'<param name="register" value="true"/>'*)
    USER="$(printf '%s' "$LINE" | sed -n 's/.*<param name="username" value="\([^"]*\)".*/\1/p')" ;;
esac
HOST="${PROXY%%:*}"
PORT=5060
case "$PROXY" in *:*) PORT="${PROXY##*:}" ;; esac
PORT="$(printf '%s' "$PORT" | tr -cd '0-9')"
IPS="$(getent ahostsv4 "$HOST" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ *$//')"
if [ -z "$IPS" ]; then
  echo "ИТОГ: узел не находит адрес $HOST — имя провайдера не разрешается (DNS)"
  exit 0
fi

DETAILS="$(mktemp)"
CAPTURE="$(mktemp)"
trap 'rm -f "$DETAILS" "$CAPTURE"' EXIT
{
  echo "Провайдер: $HOST → $IPS, порт $PORT"
  for IP in $IPS; do echo "Маршрут к $IP: $(ip route get "$IP" 2>/dev/null | head -n 1)"; done
} >"$DETAILS"

if command -v tcpdump >/dev/null 2>&1; then
  FILTER=""
  for IP in $IPS; do FILTER="${FILTER:+$FILTER or }host $IP"; done
  # -A — с текстом пакета: по нему видно, чья это учётная запись и что ответил провайдер.
  timeout "$LISTEN" tcpdump -n -l -A -i any "port $PORT and ($FILTER)" >"$CAPTURE" 2>/dev/null &
  LISTENER=$!
  sleep 1
  "$FS_CLI" -x "sofia profile zvonix register $NAME" >/dev/null 2>&1
  wait "$LISTENER" 2>/dev/null
  # Пакет начинается строкой «ЧЧ:ММ:СС.… IP <откуда>.<порт> > <куда>.<порт>: …», дальше его текст. Из каждого
  # пакета этой учётной записи — строка «IN|OUT<таб>первая строка SIP<таб>заголовок».
  PACKETS="$(awk -v ips=" $IPS " -v user="$USER" '
    function flush() {
      if (head == "") return
      if (user == "" || index(body, "sip:" user "@") > 0) {
        from = head; sub(/.* IP /, "", from); sub(/\.[0-9]+ > .*/, "", from)
        dir = index(ips, " " from " ") > 0 ? "IN" : "OUT"
        first = ""
        if (match(body, /SIP\/2\.0 [0-9][0-9][0-9][^\r\n]*/)) first = substr(body, RSTART, RLENGTH)
        else if (match(body, /[A-Z]+ sip:[^ ]+ SIP\/2\.0/)) first = substr(body, RSTART, RLENGTH)
        printf "%s\t%s\t%s\n", dir, first, head
      }
      head = ""; body = ""
    }
    /^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]\./ { flush(); head = $0; next }
    { body = body "\n" $0 }
    END { flush() }
  ' "$CAPTURE")"
  SENT="$(printf '%s\n' "$PACKETS" | grep -c '^OUT')"
  RECEIVED="$(printf '%s\n' "$PACKETS" | grep -c '^IN')"
  LAST="$(printf '%s\n' "$PACKETS" | awk -F '\t' '$1 == "IN" && $2 != "" {last = $2} END {print last}')"
  WHO="${USER:+учётной записи $USER }"
  if [ "$SENT" -eq 0 ]; then
    echo "ИТОГ: узел за $LISTEN с не отправил провайдеру ни одного запроса ${WHO}— FreeSWITCH не пробует регистрироваться"
  elif [ "$RECEIVED" -eq 0 ]; then
    echo "ИТОГ: запросов ${WHO}с узла ушло $SENT (на $IPS, порт $PORT), ответов — ни одного. Запросы уходят с узла, но провайдер их не получает или отбрасывает: это сторона провайдера или сети до него"
  else
    echo "ИТОГ: провайдер отвечает${USER:+ (учётная запись $USER)}: отправлено $SENT, получено $RECEIVED${LAST:+, последний ответ «$LAST»}"
  fi
  cat "$DETAILS"
  echo "Пакеты ${WHO}(первые 12):"
  printf '%s\n' "$PACKETS" | head -n 12 | awk -F '\t' '{print (index($3, $2) > 0 ? $3 : $3 "  " $2)}' | cut -c1-220
else
  "$FS_CLI" -x "sofia profile zvonix register $NAME" >/dev/null 2>&1
  sleep 5
  echo "ИТОГ: на узле нет tcpdump — видно только состояние регистрации"
  cat "$DETAILS"
fi
echo "Состояние: $("$FS_CLI" -x "sofia status gateway $NAME" 2>/dev/null | awk '$1=="State" || $1=="Status" {printf "%s %s  ", $1, $2}')"
SIPCHECK
chmod 0700 /usr/local/sbin/zvonix-sip-check

# --- Блокировки fail2ban (ADR-0125): список и снятие из кабинета --------------
# Кабинет «Узлы АТС» → «Блокировки»: кто заблокирован, в какой тюрьме и до какого времени, и снять блок с одного
# адреса. Через службу команд, как проверка связи. Только чтение списка и снятие одного адреса — ничего другого
# эти скрипты не делают. Ответ: первая строка «ИТОГ: …», дальше блокировка на строку —
# «<тюрьма> <адрес> <до, секунды эпохи или ->». Тюрьмы — коротко: f — SIP чужие логины, k — SIP свои, s — SSH:
# ответ узла обрезается на 16000 знаков, и короткая строка вмещает больше адресов.
cat >/usr/local/sbin/zvonix-bans <<'BANS'
#!/bin/sh
# Список блокировок fail2ban узла (ADR-0125) — порождается node/install.sh, правится там.
set -u
command -v fail2ban-client >/dev/null 2>&1 || { echo 'ИТОГ: fail2ban на узле не установлен'; exit 0; }
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
for PAIR in f:zvonix-freeswitch k:zvonix-freeswitch-known s:sshd; do
  CODE="${PAIR%%:*}"
  JAIL="${PAIR#*:}"
  fail2ban-client status "$JAIL" >/dev/null 2>&1 || continue
  # fail2ban 1.0: «адрес <таб>начало + длительность = конец»; старый не знает --with-time — тогда без срока.
  OUT="$(fail2ban-client get "$JAIL" banip --with-time 2>/dev/null)" || OUT=""
  if [ -z "$OUT" ]; then
    OUT="$(fail2ban-client get "$JAIL" banip 2>/dev/null | tr ' ' '\n')"
  fi
  printf '%s\n' "$OUT" | while IFS= read -r LINE; do
    IP="$(printf '%s' "$LINE" | awk '{print $1}' | tr -cd '0-9a-fA-F.:')"
    [ -n "$IP" ] || continue
    END="$(printf '%s' "$LINE" | sed -n 's/.* = \([0-9-]\{10\} [0-9:]\{8\}\).*/\1/p')"
    UNTIL=-
    [ -n "$END" ] && UNTIL="$(date -d "$END" +%s 2>/dev/null | tr -cd '0-9')"
    echo "$CODE $IP ${UNTIL:--}"
  done
done >"$LIST"
echo "ИТОГ: блокировок $(wc -l <"$LIST" | tr -d ' ')"
cat "$LIST"
BANS
chmod 0700 /usr/local/sbin/zvonix-bans

cat >/usr/local/sbin/zvonix-unban <<'UNBAN'
#!/bin/sh
# Снять блокировку одного адреса во всех тюрьмах узла (ADR-0125) — порождается node/install.sh, правится там.
set -u
IP="${1:-}"
# Только адрес: цифры, точки, двоеточия, до 45 знаков. Площадка проверяет то же, но узел верит только себе.
case "$IP" in
  '' | *[!0-9a-fA-F.:]*) echo 'ИТОГ: неверный адрес'; exit 0 ;;
esac
[ "${#IP}" -le 45 ] || { echo 'ИТОГ: неверный адрес'; exit 0; }
command -v fail2ban-client >/dev/null 2>&1 || { echo 'ИТОГ: fail2ban на узле не установлен'; exit 0; }
DONE=""
for JAIL in zvonix-freeswitch zvonix-freeswitch-known sshd; do
  case " $(fail2ban-client get "$JAIL" banip 2>/dev/null | tr '\n' ' ') " in
    *" $IP "*) fail2ban-client set "$JAIL" unbanip "$IP" >/dev/null 2>&1 && DONE="$DONE $JAIL" ;;
  esac
done
if [ -n "$DONE" ]; then
  echo "ИТОГ: блокировка снята"
  echo "Тюрьмы:$DONE"
else
  echo 'ИТОГ: адрес не заблокирован'
fi
UNBAN
chmod 0700 /usr/local/sbin/zvonix-unban

# --- Служба команд узла (ADR-0115, GET /node/commands) -------------------------
# Тестовый звонок и сброс входа площадка отдаёт по ESL только узлу своей машины. Узел на отдельной
# машине сам забирает их долгим запросом, выполняет и присылает ответ. Выполняет только шесть
# разрешённых команд (звонок, сброс входа, проверка связи, список и снятие блокировки, обрыв разговора по UUID) —
# прочие отвергает. ESL наружу не открывается.
# Ключ — в файле только для root, в аргументы процесса не попадает; адрес — в самом скрипте.

( umask 077 && printf 'user = "%s:%s"\n' "$KEY_ID" "$KEY_SECRET" >"${NODE_ETC}/commands.curl" )

cat >/usr/local/sbin/zvonix-commands <<COMMANDS_HEAD
#!/bin/sh
# Служба команд узла Zvonix (ADR-0115) — порождается node/install.sh, правится там.
FS_CLI="${FS_CLI}"
CONTROL_PLANE="${CONTROL_PLANE}"
AUTH="${NODE_ETC}/commands.curl"
COMMANDS_HEAD
cat >>/usr/local/sbin/zvonix-commands <<'COMMANDS'
set -u
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

# Ответ FreeSWITCH площадке. Не дошёл — итог звонка всё равно придёт с CDR.
report() {
  printf '%s' "$2" | curl -sS --max-time 15 -K "$AUTH" -X POST -H 'Content-Type: text/plain' \
    --data-binary @- "${CONTROL_PLANE}/node/commands/$1/result" >/dev/null 2>&1 || true
}

while :; do
  # Площадка держит запрос до 25 с: 200 — команда, 204 — команд нет. Площадка недоступна — пауза.
  CODE="$(curl -sS --max-time 40 -K "$AUTH" -o "$BODY" -w '%{http_code}' \
    "${CONTROL_PLANE}/node/commands" 2>/dev/null)" || CODE=000
  case "$CODE" in
    200) ;;
    204) continue ;;
    *) sleep 5; continue ;;
  esac
  ID="$(sed -n 1p "$BODY" | tr -cd '0-9a-f-')"
  API="$(sed -n 2p "$BODY")"
  [ -n "$ID" ] || continue
  case "$API" in
    # originate держит ответ, пока абонент не снимет трубку, — в фоне, чтобы не ждать следующую команду.
    'originate {'*|'sofia profile zvonix flush_inbound_reg '*)
      ( report "$ID" "$("$FS_CLI" -x "$API" 2>&1)" ) & ;;
    # Проверка связи с провайдером (ADR-0122): свой скрипт, имя транка он чистит и ищет в файле сам.
    'zvonix-sip-check '*)
      ( report "$ID" "$(/usr/local/sbin/zvonix-sip-check "${API#zvonix-sip-check }" 2>&1 | head -c 8000)" ) & ;;
    # Блокировки fail2ban (ADR-0125): список — только чтение; снятие — одного адреса, адрес скрипт проверяет сам.
    'zvonix-bans')
      ( report "$ID" "$(/usr/local/sbin/zvonix-bans 2>&1 | head -c 16000)" ) & ;;
    'zvonix-unban '*)
      ( report "$ID" "$(/usr/local/sbin/zvonix-unban "${API#zvonix-unban }" 2>&1 | head -c 2000)" ) & ;;
    # Обрыв разговора, когда у клиента кончились деньги (ADR-0126): строго UUID канала, ничего больше.
    'uuid_kill '*)
      CALL="${API#uuid_kill }"
      if printf '%s' "$CALL" | grep -Eqx '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'; then
        ( report "$ID" "$("$FS_CLI" -x "uuid_kill $CALL" 2>&1 | head -c 4000)" ) &
      else
        report "$ID" '-ERR NODE_REFUSED'
      fi ;;
    *) report "$ID" '-ERR NODE_REFUSED' ;;
  esac
done
COMMANDS
chmod 0700 /usr/local/sbin/zvonix-commands

cat >/etc/systemd/system/zvonix-commands.service <<'UNIT'
[Unit]
Description=Служба команд узла Zvonix: тестовый звонок и сброс входа
Wants=network-online.target
After=network-online.target freeswitch.service

[Service]
ExecStart=/usr/local/sbin/zvonix-commands
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable zvonix-commands.service >/dev/null 2>&1
# Перезапуск, а не start: при обновлении служба должна взять новый скрипт.
if systemctl restart zvonix-commands.service; then
  echo "Служба команд узла запущена: тестовый звонок с SIM доступен"
else
  echo "ВНИМАНИЕ: служба команд узла не запустилась — тестовый звонок недоступен (journalctl -u zvonix-commands)" >&2
fi

# --- Выгрузка записей разговоров (ADR-0063, docs/api/recordings.md) ----------
# Диалплан пишет разговор в ${recordings_dir}/<вызов>.wav. Раз в 30 секунд закрытые файлы
# уходят на площадку по подписанной ссылке: узел спрашивает ссылку (POST /node/recordings/upload-url),
# кладёт файл, сообщает длительность и размер (POST /node/recordings/uploaded) и только
# потом удаляет свой. Недоставленное лежит и уходит в следующий проход (догоняющая выгрузка).
# Окончательный отказ площадки (4xx, кроме 408/429) переносит файл в rejected/ на неделю:
# вечный повтор забил бы каждый проход одним и тем же файлом. Ключ узла — отдельным файлом
# только для root; ключей хранилища у узла нет вообще — только ссылка на один объект.

( umask 077 && printf 'user = "%s:%s"\n' "$KEY_ID" "$KEY_SECRET" >"${NODE_ETC}/recordings.curl" )

cat >/usr/local/sbin/zvonix-recordings <<RECORDINGS
#!/bin/bash
# Выгрузка записей разговоров Zvonix — порождается node/install.sh, правится там.
set -u
DIR="\$("${FS_CLI}" -x 'global_getvar recordings_dir' 2>/dev/null | head -1)"
[ -n "\$DIR" ] && [ -d "\$DIR" ] || exit 0
API="${CONTROL_PLANE}"
CREDS="${NODE_ETC}/recordings.curl"
REJECTED="\$DIR/rejected"
NOW="\$(date +%s)"
DONE=0

for FILE in "\$DIR"/*.wav; do
  [ -f "\$FILE" ] || continue
  [ "\$DONE" -lt 20 ] || break
  # Закрытый файл: 20 секунд без изменений. FreeSWITCH дописывает заголовок при закрытии.
  [ \$((NOW - \$(stat -c %Y "\$FILE"))) -ge 20 ] || continue
  ID="\$(basename "\$FILE" .wav)"
  case "\$ID" in ????????-????-????-????-????????????) ;; *) continue ;; esac
  SIZE="\$(stat -c %s "\$FILE")"
  # Только заголовок — разговор не записался; площадке такой файл не нужен.
  [ "\$SIZE" -gt 44 ] || { rm -f "\$FILE"; continue; }

  RESPONSE="\$(curl -sS --max-time 20 -K "\$CREDS" -H 'Content-Type: application/json' \
    -d "{\\"callId\\":\\"\$ID\\"}" -w '\n%{http_code}' "\$API/node/recordings/upload-url")" || continue
  CODE="\${RESPONSE##*\$'\n'}"
  BODY="\${RESPONSE%\$'\n'*}"
  case "\$CODE" in
    200) ;;
    409) rm -f "\$FILE"; continue ;;
    408|429) continue ;;
    4??) mkdir -p "\$REJECTED"; mv -f "\$FILE" "\$REJECTED/"; echo "запись \$ID отклонена площадкой (\$CODE)" >&2; continue ;;
    *) continue ;;
  esac
  URL="\$(printf '%s' "\$BODY" | sed -n 's/.*"upload_url":"\([^"]*\)".*/\1/p')"
  [ -n "\$URL" ] || continue

  curl -fsS --max-time 300 -T "\$FILE" -H 'Content-Type: audio/wav' "\$URL" >/dev/null || continue

  # Длительность — по заголовку WAV: частота, каналы, разрядность.
  RATE="\$(od -An -tu4 -j24 -N4 "\$FILE" | tr -d ' ')"
  CHANNELS="\$(od -An -tu2 -j22 -N2 "\$FILE" | tr -d ' ')"
  BITS="\$(od -An -tu2 -j34 -N2 "\$FILE" | tr -d ' ')"
  PER_SECOND=\$((RATE * CHANNELS * BITS / 8))
  SECONDS_LONG=0
  [ "\$PER_SECOND" -gt 0 ] && SECONDS_LONG=\$(((SIZE - 44) / PER_SECOND))

  curl -fsS --max-time 20 -K "\$CREDS" -H 'Content-Type: application/json' \
    -d "{\\"callId\\":\\"\$ID\\",\\"durationSeconds\\":\$SECONDS_LONG,\\"sizeBytes\\":\$SIZE}" \
    "\$API/node/recordings/uploaded" >/dev/null || continue
  rm -f "\$FILE"
  DONE=\$((DONE + 1))
done

[ -d "\$REJECTED" ] && find "\$REJECTED" -name '*.wav' -mtime +7 -delete
exit 0
RECORDINGS
chmod 0700 /usr/local/sbin/zvonix-recordings

cat >/etc/systemd/system/zvonix-recordings.service <<'UNIT'
[Unit]
Description=Выгрузка записей разговоров Zvonix на площадку
After=network-online.target freeswitch.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/zvonix-recordings
UNIT

cat >/etc/systemd/system/zvonix-recordings.timer <<'UNIT'
[Unit]
Description=Выгрузка записей Zvonix раз в 30 секунд

[Timer]
OnBootSec=45s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now zvonix-recordings.timer >/dev/null 2>&1
echo "Выгрузка записей настроена: раз в 30 секунд (journalctl -u zvonix-recordings)"

# --- Команда обновления узла -------------------------------------------------
# Узел на другой машине выкладка площадки не видит: его обновляют этой командой.
# Скрипт скачивается целиком и только потом исполняется: в конвейере `curl | bash`
# оборванная загрузка исполнилась бы наполовину.

cat >/usr/local/sbin/zvonix-node-update <<UPDATE
#!/bin/sh
# Обновление узла Zvonix набором текущего выпуска площадки — порождается node/install.sh.
set -eu
SCRIPT="\$(mktemp)"
trap 'rm -f "\$SCRIPT"' EXIT
# Площадка на этой же машине: скрипт собирается из её выпуска (каталог root, подпись проверена), а не берётся
# у её API — исполняет его root, и взломанный API иначе получил бы root (ADR-0109).
RELEASE=/opt/zvonix/current
if [ -f "\$RELEASE/apps/api/dist/modules/nodes/node-script.js" ] && [ -r /etc/zvonix/zvonix.env ]; then
  sudo -u zvonix sh -c 'set -a; . /etc/zvonix/zvonix.env; set +a; cd "\$0/apps/api" && exec node dist/modules/nodes/node-script.js' \\
    "\$RELEASE" >"\$SCRIPT"
  [ -s "\$SCRIPT" ]
else
  curl -fsSL --max-time 60 -o "\$SCRIPT" "${CONTROL_PLANE}/install.sh"
fi
# Один запуск за раз: автообновление из пульса и ручной вызов не должны идти вдвоём.
exec flock -n /run/zvonix-node-update.lock bash "\$SCRIPT" --update
UPDATE
chmod 0700 /usr/local/sbin/zvonix-node-update

echo
# Версия набора записывается, только когда он применён целиком: отложенная конфигурация
# (звонки не кончились) оставляет прежнюю версию, и автообновление повторит попытку.
if [ "$CONF_POSTPONED" != yes ] && [ -n "$NODE_SET_VERSION" ]; then
  ( umask 077 && echo "$NODE_SET_VERSION" >"${NODE_ETC}/set-version" )
fi
if [ "$MODE" = update ]; then
  if [ "$CONF_POSTPONED" = yes ]; then
    echo "Узел обновлён частично: правила блокировки и пульс — да, конфигурация FreeSWITCH — отложена."
    exit 3
  fi
  echo "Готово. Узел обновлён набором площадки, профиль SIP zvonix работает."
  exit 0
fi
echo "Готово. Узел «${NODE_NAME}» настроен, профиль SIP zvonix работает."
# Новое ядро или библиотеки после обновления вступают в силу только после перезагрузки.
if [ -f /var/run/reboot-required ]; then
  echo "Нужна перезагрузка сервера (обновилось ядро): выполните sudo reboot, когда на узле нет звонков. FreeSWITCH и пульс поднимутся сами"
fi
echo
echo "Обновить узел до набора нового выпуска площадки: zvonix-node-update"
echo "(узел на одной машине с площадкой обновляет сама выкладка — zvonix-deploy)."
echo
echo "Проверить, что ключ принимается с этого адреса:"
echo "  curl -fsS -u '${KEY_ID}:<секрет>' ${CONTROL_PLANE}/machine/self"
echo
echo "Секрет ключа лежит в ${CONF_DIR}/autoload_configs/xml_curl.conf.xml и больше"
echo "нигде не показывается: control plane хранит только его хеш."
