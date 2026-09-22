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
# свой адрес, параметры репозитория пакетов и **сами шаблоны конфигурации** внутрь
# (ADR-0045). Поэтому скрипт ничего не читает с диска: у него нет шага, на котором
# он может оказаться без своих файлов. Прежняя редакция читала `./conf` рядом с собой
# и в конвейере `curl | bash` не находила ничего — `$0` там равно `bash`.
#
# Целевая ОС — Ubuntu. Скрипт идемпотентен: повторный запуск с новым токеном
# перенастраивает узел, не ломая уже работающий.

set -euo pipefail

TOKEN="${1:-}"
CONTROL_PLANE="${ZVONIX_CONTROL_PLANE:-@@CONTROL_PLANE@@}"
PACKAGE_REPO="${ZVONIX_PACKAGE_REPO:-@@PACKAGE_REPO@@}"
PACKAGE_SUITE="${ZVONIX_PACKAGE_SUITE:-@@PACKAGE_SUITE@@}"
PACKAGE_KEY_FINGERPRINT="${ZVONIX_PACKAGE_KEY_FINGERPRINT:-@@PACKAGE_KEY_FINGERPRINT@@}"
CONF_DIR="${ZVONIX_CONF_DIR:-}"
STATE_DIR="${ZVONIX_STATE_DIR:-/var/lib/zvonix}"
KEYRING="/usr/share/keyrings/zvonix-packages.gpg"

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
[ "$CONTROL_PLANE" != "@@CONTROL_PLANE@@" ] || die "адрес control plane не подставлен"
# Репозиторий нужен ровно затем, чтобы **поставить** FreeSWITCH. Если он уже стоит,
# ставить нечего, и требовать адрес значило бы не пускать на узел, которому он не нужен.
# Первый узел площадки поднимается именно так: FreeSWITCH на нём собран руками,
# а команда из панели его только регистрирует и настраивает.
if command -v freeswitch >/dev/null 2>&1; then
  NEED_PACKAGES=no
else
  NEED_PACKAGES=yes
  case "$PACKAGE_REPO" in
    ""|"@@PACKAGE_REPO@@")
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

if [ -n "$PACKAGE_KEY_FINGERPRINT" ] && [ "$PACKAGE_KEY_FINGERPRINT" != "@@PACKAGE_KEY_FINGERPRINT@@" ]; then
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

# --- Конфигурация ------------------------------------------------------------

install -d -m 0750 "$STATE_DIR" "${STATE_DIR}/cdr-failed" "${STATE_DIR}/rec"
install -d -m 0755 "${CONF_DIR}/autoload_configs"

# Секрет попадает в файлы конфигурации, и это единственный способ, которым
# FreeSWITCH умеет аутентифицироваться (ADR-0019). Права закрываются сразу:
# кто получил root на узле, получил и ключ, но остальным его видеть незачем.
umask 077

# Шаблоны лежат внутри самого скрипта: их вложил control plane, отдавая его.
# Подстановки `@@KEY_ID@@` и `@@KEY_SECRET@@` он оставил нетронутыми — ключа
# на его стороне не существует, он появляется только здесь.
xml_curl_template() {
  cat <<'ZVONIX_TEMPLATE_EOF'
@@TEMPLATE_XML_CURL@@
ZVONIX_TEMPLATE_EOF
}

json_cdr_template() {
  cat <<'ZVONIX_TEMPLATE_EOF'
@@TEMPLATE_JSON_CDR@@
ZVONIX_TEMPLATE_EOF
}

apply_template() {
  local produce="$1" target="$2"

  "$produce" | sed \
    -e "s|@@CONTROL_PLANE@@|${CONTROL_PLANE}|g" \
    -e "s|@@KEY_ID@@|${KEY_ID}|g" \
    -e "s|@@KEY_SECRET@@|${KEY_SECRET}|g" \
    > "$target"
  chmod 0640 "$target"
  echo "Записан $target"
}

# --- Загрузка модулей ---------------------------------------------------------
# Собранный модуль сам собой не загружается: его имя должно стоять в списке
# автозагрузки. Штатная конфигурация FreeSWITCH держит `mod_xml_curl`
# **закомментированным**, а `mod_json_cdr` не упоминает вовсе — проверено на живой
# установке 1.10.12. Без этого узел настраивается, выглядит рабочим и при этом
# не спрашивает маршрут и не шлёт CDR: то есть не звонит и не выставляет счетов.

ensure_module() {
  local module="$1"
  local file="${CONF_DIR}/autoload_configs/modules.conf.xml"

  [ -f "$file" ] || die "не найден ${file} — FreeSWITCH установлен не полностью"

  # Сначала снимаем комментарий, если строка есть, но выключена.
  sed -i "s|<!--[[:space:]]*<load module=\"${module}\"/>[[:space:]]*-->|<load module=\"${module}\"/>|" "$file"

  # Если строки нет вовсе — дописываем перед закрывающим тегом.
  if ! grep -q "<load module=\"${module}\"/>" "$file"; then
    sed -i "s|</modules>|  <load module=\"${module}\"/>\n  </modules>|" "$file"
  fi
}

ensure_module mod_xml_curl
ensure_module mod_json_cdr
echo "Модули маршрута и CDR включены в автозагрузку"

apply_template xml_curl_template "${CONF_DIR}/autoload_configs/xml_curl.conf.xml"
apply_template json_cdr_template "${CONF_DIR}/autoload_configs/json_cdr.conf.xml"

chown -R freeswitch:freeswitch "$STATE_DIR" "$CONF_DIR" 2>/dev/null || true

# --- Запуск ------------------------------------------------------------------

systemctl enable freeswitch >/dev/null 2>&1 || true
systemctl restart freeswitch

echo
echo "Готово. Узел «${NODE_NAME}» настроен."
echo
echo "Проверить, что ключ принимается с этого адреса:"
echo "  curl -fsS -u '${KEY_ID}:<секрет>' ${CONTROL_PLANE}/machine/self"
echo
echo "Секрет ключа лежит в ${CONF_DIR}/autoload_configs/xml_curl.conf.xml и больше"
echo "нигде не показывается: control plane хранит только его хеш."
