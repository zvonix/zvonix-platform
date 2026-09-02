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
# Целевая ОС — Ubuntu. Скрипт идемпотентен: повторный запуск с новым токеном
# перенастраивает узел, не ломая уже работающий.

set -euo pipefail

TOKEN="${1:-}"
CONTROL_PLANE="${ZVONIX_CONTROL_PLANE:-@@CONTROL_PLANE@@}"
CONF_DIR="${ZVONIX_CONF_DIR:-/etc/freeswitch}"
STATE_DIR="${ZVONIX_STATE_DIR:-/var/lib/zvonix}"

die() {
  echo "Ошибка: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "не найдена команда $1"
}

# --- Проверки до любых изменений ---------------------------------------------
# Скрипт ничего не трогает, пока не убедился, что сможет доделать до конца:
# наполовину настроенный узел хуже ненастроенного, потому что выглядит рабочим.

[ -n "$TOKEN" ] || die "не передан токен установки. Команду выдаёт панель управления"
[ "$(id -u)" -eq 0 ] || die "нужны права root: запускайте через sudo"
[ "$CONTROL_PLANE" != "@@CONTROL_PLANE@@" ] || die "адрес control plane не подставлен"

require curl
require sed
require python3

case "$CONTROL_PLANE" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*)
    echo "ВНИМАНИЕ: control plane по http. Допустимо только при локальной отладке:" >&2
    echo "          по этому каналу уходит секрет ключа узла." >&2
    ;;
  *) die "control plane должен быть по https: по этому каналу уходит секрет ключа" ;;
esac

HOSTNAME_FQDN="$(hostname -f 2>/dev/null || hostname)"
[ -n "$HOSTNAME_FQDN" ] || die "не удалось определить имя машины"

# --- Обмен токена на постоянный ключ -----------------------------------------
# Выполняется ДО установки пакетов: если токен просрочен или уже применён,
# незачем ставить полгигабайта зависимостей.

echo "Регистрация узла ${HOSTNAME_FQDN} в ${CONTROL_PLANE}"

ENROLL_BODY="$(
  curl -fsSL --max-time 30 \
    -H "Authorization: Bearer ${TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"hostname\":\"${HOSTNAME_FQDN}\",\"agentVersion\":\"install.sh\"}" \
    "${CONTROL_PLANE}/node/enroll"
)" || die "регистрация не удалась. Токен просрочен, уже применён или адрес недоступен"

# Разбор JSON без jq: он есть не везде, а python3 в Ubuntu есть всегда.
read_field() {
  printf '%s' "$ENROLL_BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
node = data
for part in sys.argv[1].split('.'):
    node = node[part]
print(node)
" "$1"
}

KEY_ID="$(read_field key.key_id)" || die "в ответе регистрации нет идентификатора ключа"
KEY_SECRET="$(read_field key.secret)" || die "в ответе регистрации нет секрета ключа"
NODE_NAME="$(read_field node.name)" || die "в ответе регистрации нет имени узла"

[ -n "$KEY_ID" ] && [ -n "$KEY_SECRET" ] || die "пустые учётные данные в ответе регистрации"

echo "Узел «${NODE_NAME}» зарегистрирован, ключ ${KEY_ID}"

# --- Установка FreeSWITCH ----------------------------------------------------

if ! command -v freeswitch >/dev/null 2>&1; then
  echo "Установка FreeSWITCH"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq freeswitch freeswitch-mod-sofia freeswitch-mod-xml-curl \
    freeswitch-mod-json-cdr freeswitch-mod-commands freeswitch-mod-dptools \
    freeswitch-mod-sndfile freeswitch-mod-event-socket
else
  echo "FreeSWITCH уже установлен, пропускаю"
fi

# --- Конфигурация ------------------------------------------------------------

install -d -m 0750 "$STATE_DIR" "${STATE_DIR}/cdr-failed" "${STATE_DIR}/rec"
install -d -m 0755 "${CONF_DIR}/autoload_configs"

# Секрет попадает в файлы конфигурации, и это единственный способ, которым
# FreeSWITCH умеет аутентифицироваться (ADR-0019). Права закрываются сразу:
# кто получил root на узле, получил и ключ, но остальным его видеть незачем.
umask 077

apply_template() {
  local source="$1" target="$2"
  [ -f "$source" ] || die "не найден шаблон $source"

  sed \
    -e "s|@@CONTROL_PLANE@@|${CONTROL_PLANE}|g" \
    -e "s|@@KEY_ID@@|${KEY_ID}|g" \
    -e "s|@@KEY_SECRET@@|${KEY_SECRET}|g" \
    "$source" > "$target"
  chmod 0640 "$target"
  echo "Записан $target"
}

TEMPLATES="$(dirname "$0")/conf"
apply_template "${TEMPLATES}/autoload_configs/xml_curl.conf.xml" \
  "${CONF_DIR}/autoload_configs/xml_curl.conf.xml"
apply_template "${TEMPLATES}/autoload_configs/json_cdr.conf.xml" \
  "${CONF_DIR}/autoload_configs/json_cdr.conf.xml"

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
echo "нигде не восстанавливается. Потерян — выпустите новый в панели и отзовите старый."
