#!/usr/bin/env bash
# Подготовка сервера площадки (ADR-0049). Запускается от root; повторный запуск создаёт
# недостающее и не трогает уже заданное — окружение и секреты не переписываются, кроме
# адреса кабинета: его задаёт этот же вызов.
#
#   server-setup.sh [адрес кабинета]
#     без адреса              тот, что уже записан в zvonix.env; на новом сервере — туннель
#     http://localhost:8080   стенд, кабинет через SSH-туннель
#     cp.example.ru           домен (то же, что https://cp.example.ru) — сайт на 443,
#                             сертификат Let's Encrypt выпускается и продлевается сам
#
# Ставит Node 22, PostgreSQL 16, Redis 7 и nginx, заводит пользователя zvonix, базу
# и секреты, включает файрвол. Панели управления нет: сервер описан этим скриптом.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

ETC=/etc/zvonix
ENV_FILE="${ETC}/zvonix.env"
ACME_ROOT=/var/www/letsencrypt

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

# Адрес кабинета, записанный прошлой подготовкой; пусто, если её не было.
recorded_address() {
  if [ -f "$ENV_FILE" ]; then
    sed -n 's/^WEB_BASE_URL=//p' "$ENV_FILE" | tail -1
  fi
}

[ "$(id -u)" -eq 0 ] || die "нужны права root"

# Без адреса берётся записанный: повторная подготовка сервера с доменом не должна
# возвращать сайт на туннель.
WEB_ADDRESS="${1:-$(recorded_address)}"
WEB_ADDRESS="${WEB_ADDRESS:-http://localhost:8080}"
# Домен без схемы — это https: кабинета с доменом по открытому http не бывает.
case "$WEB_ADDRESS" in
  *://*) ;;
  *) WEB_ADDRESS="https://${WEB_ADDRESS}" ;;
esac
WEB_ADDRESS="${WEB_ADDRESS%/}"

# Адрес кабинета разбирается до любых изменений: ошибка в нём не должна оставить сервер
# настроенным наполовину.
case "$WEB_ADDRESS" in
  http://localhost:* | http://127.0.0.1:*)
    [[ "$WEB_ADDRESS" =~ ^http://(localhost|127\.0\.0\.1):([0-9]{2,5})$ ]] \
      || die "адрес ${WEB_ADDRESS} недопустим — для туннеля http://localhost:<порт>"
    SITE_LISTEN="listen 127.0.0.1:${BASH_REMATCH[2]};"
    SITE_NAME="_"
    PUBLIC_SITE=no
    ;;
  https://*)
    SITE_NAME="${WEB_ADDRESS#https://}"
    [[ "$SITE_NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$SITE_NAME" == *.* ]] \
      || die "домен в адресе ${WEB_ADDRESS} недопустим — нужно имя вида cp.example.ru, без пути и порта"
    [[ ! "$SITE_NAME" =~ ^[0-9.]+$ ]] || die "нужен домен, а не IP-адрес: сертификат выпускается на имя"
    CERT_DIR="/etc/letsencrypt/live/${SITE_NAME}"
    # Сайт на 443; порт 80 обслуживает отдельный сайт — проверка ACME и перенаправление.
    SITE_LISTEN="listen 443 ssl;\n    listen [::]:443 ssl;\n    ssl_certificate ${CERT_DIR}/fullchain.pem;\n    ssl_certificate_key ${CERT_DIR}/privkey.pem;\n    ssl_protocols TLSv1.2 TLSv1.3;\n    add_header Strict-Transport-Security \"max-age=31536000\" always;"
    PUBLIC_SITE=yes
    ;;
  *)
    die "адрес кабинета — домен (cp.example.ru) или http://localhost:<порт> для туннеля"
    ;;
esac
SITE_TEMPLATE="$(dirname "$0")/nginx/zvonix.conf"
ACME_TEMPLATE="$(dirname "$0")/nginx/zvonix-acme.conf"
[ -f "$SITE_TEMPLATE" ] && [ -f "$ACME_TEMPLATE" ] || die "нет шаблонов в $(dirname "$0")/nginx — запускайте из каталога deploy/ целиком"

# shellcheck source=/dev/null
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "ВНИМАНИЕ: проверено на Ubuntu 24.04, здесь ${PRETTY_NAME:-неизвестно}" >&2

# Сертификат выпустится, только если Let's Encrypt найдёт этот сервер по имени. Имени нет
# в DNS вовсе — дальше идти незачем, и это видно до любых изменений. Имя указывает не сюда —
# предупреждение, а не отказ: сервер за NAT своего внешнего адреса не видит, и ответ
# тогда даст сам выпуск сертификата.
if [ "$PUBLIC_SITE" = yes ]; then
  step "DNS ${SITE_NAME}"
  resolved="$(getent ahosts "$SITE_NAME" | awk '{ print $1 }' | sort -u | grep -Ev '^(127\.|::1$)' || true)"
  [ -n "$resolved" ] || die "домен ${SITE_NAME} не найден в DNS — заведите запись A с адресом этого сервера; новая запись расходится от минут до часа"
  own="$(ip -o addr show scope global | awk '{ split($4, a, "/"); print a[1] }')"
  for address in $resolved; do
    if grep -qxF "$address" <<<"$own"; then
      echo "${SITE_NAME} → ${address}: адрес этого сервера"
    else
      echo "ВНИМАНИЕ: ${SITE_NAME} → ${address}, а у сервера адреса: $(echo "$own" | tr '\n' ' ')— если сервер не за NAT, поправьте запись A (и AAAA: Let's Encrypt проверяет по ней первой)" >&2
    fi
  done
fi

step "Пакеты"
install -d -m 0755 /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/nodesource.gpg ]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
fi
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  >/etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs postgresql-16 redis-server nginx ufw python3 sudo ca-certificates
[ "$PUBLIC_SITE" = no ] || apt-get install -y -qq certbot
systemctl enable --now postgresql redis-server
# pnpm ставит corepack той версии, что закреплена в `packageManager` выпуска.
corepack enable

# Воркер отказывается работать с Redis, который вытесняет ключи (ADR-0020).
policy="$(redis-cli config get maxmemory-policy | tail -1)"
[ "$policy" = "noeviction" ] || die "в Redis maxmemory-policy=${policy}, нужна noeviction (ADR-0020)"

step "Пользователь и каталоги"
id zvonix >/dev/null 2>&1 || useradd --system --home-dir /opt/zvonix --shell /usr/sbin/nologin zvonix
install -d -o zvonix -g zvonix -m 0750 /opt/zvonix /opt/zvonix/releases
install -d -o root -g zvonix -m 0750 "$ETC"

step "Секреты"
# Порождаются здесь и сервер не покидают. Файл — только root: процессы площадки
# получают секреты через zvonix.env.
SECRETS="${ETC}/secrets.env"
if [ ! -s "$SECRETS" ]; then
  (
    umask 077
    {
      echo "DB_PASSWORD=$(openssl rand -hex 24)"
      echo "SECRET_KEY=$(openssl rand -hex 32)"
    } >"$SECRETS"
  )
fi
chown root:root "$SECRETS"
chmod 0600 "$SECRETS"
# shellcheck source=/dev/null
. "$SECRETS"

step "База"
# Пароль из шестнадцатеричных знаков: подстановка в текст запроса безопасна.
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'zvonix') THEN
    CREATE ROLE zvonix LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'zvonix'" | grep -q 1 \
  || sudo -u postgres createdb -O zvonix zvonix

step "Окружение площадки"
ADDRESS_CHANGED=no
if [ ! -s "$ENV_FILE" ]; then
  (
    umask 027
    cat >"$ENV_FILE" <<EOF
APP_ENV=production
APP_HOST=127.0.0.1
APP_PORT=8000
# Адрес, по которому к площадке ходят узлы АТС. Узел на этом же сервере — 127.0.0.1;
# на отдельном сервере — только https и домен (ADR-0045).
PUBLIC_BASE_URL=http://127.0.0.1:8000
# Адрес кабинета: письма, код первого запуска, Secure у cookie входа.
WEB_BASE_URL=${WEB_ADDRESS}
LOG_LEVEL=info
LOG_FORMAT=json
DATABASE_URL=postgresql://zvonix:${DB_PASSWORD}@127.0.0.1:5432/zvonix
REDIS_URL=redis://127.0.0.1:6379
# nginx стоит на этой же машине: X-Forwarded-For принимается только от него.
TRUSTED_PROXIES=loopback
SECRET_KEY=${SECRET_KEY}
# Корневой сертификат Минцифры — в системном хранилище (ADR-0032).
NODE_OPTIONS=--use-system-ca
EOF
  )
  echo "записан ${ENV_FILE} — остальные настройки см. .env.example"
else
  echo "${ENV_FILE} уже есть — заданное не трогаю, кроме адреса кабинета"
  # Адрес кабинета — единственное, что подготовка меняет в готовом окружении: его задаёт
  # тот же вызов, что строит сайт nginx, и разойтись они не должны. По нему собираются
  # ссылки в письмах, код первого запуска (ADR-0050) и признак Secure у cookie входа
  # (ADR-0037). Без адреса в вызове берётся записанный, так что повтор его не меняет.
  current="$(recorded_address)"
  if [ -z "$current" ]; then
    printf '# Адрес кабинета: письма, код первого запуска, Secure у cookie входа.\nWEB_BASE_URL=%s\n' \
      "$WEB_ADDRESS" >>"$ENV_FILE"
    echo "дописан WEB_BASE_URL=${WEB_ADDRESS}"
    ADDRESS_CHANGED=yes
  elif [ "$current" != "$WEB_ADDRESS" ]; then
    sed -i "s|^WEB_BASE_URL=.*|WEB_BASE_URL=${WEB_ADDRESS}|" "$ENV_FILE"
    echo "адрес кабинета: ${current} → ${WEB_ADDRESS}"
    ADDRESS_CHANGED=yes
  fi
fi
chown root:zvonix "$ENV_FILE"
chmod 0640 "$ENV_FILE"

step "Доступ к выпускам GitHub"
GITHUB_ENV_FILE="${ETC}/github.env"
if [ ! -e "$GITHUB_ENV_FILE" ]; then
  (
    umask 077
    cat >"$GITHUB_ENV_FILE" <<'EOF'
# Выпуски площадки (ADR-0049). Токен fine-grained: один репозиторий, «Contents: Read-only».
GITHUB_REPOSITORY=
GITHUB_TOKEN=
EOF
  )
  echo "заготовка ${GITHUB_ENV_FILE} — впишите репозиторий и токен"
fi
# Токен из окружения — так его передаёт установка одной командой (ADR-0050). Пишется,
# только если в файле токена нет: заданный руками не переписывается.
if [ -n "${GITHUB_TOKEN:-}" ] && ! grep -q '^GITHUB_TOKEN=.' "$GITHUB_ENV_FILE"; then
  (
    umask 077
    printf 'GITHUB_REPOSITORY=%s\nGITHUB_TOKEN=%s\n' \
      "${GITHUB_REPOSITORY:-zvonix/zvonix-platform}" "$GITHUB_TOKEN" >"$GITHUB_ENV_FILE"
  )
  echo "токен GitHub записан в ${GITHUB_ENV_FILE}"
fi
chown root:root "$GITHUB_ENV_FILE"
chmod 0600 "$GITHUB_ENV_FILE"

if [ -f "$(dirname "$0")/deploy.sh" ]; then
  install -m 0755 "$(dirname "$0")/deploy.sh" /usr/local/sbin/zvonix-deploy
fi

step "Файрвол"
# Порт SSH — первым и тем, что действительно слушает sshd: иначе включение файрвола
# отрезало бы доступ к серверу, и чинить пришлось бы через консоль хостинга.
SSH_PORTS="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }')"
[ -n "$SSH_PORTS" ] || die "не удалось узнать порт SSH у sshd — файрвол не включаю, чтобы не отрезать доступ"

# Диапазон голоса — из конфигурации FreeSWITCH, если он там задан; иначе встроенный
# в FreeSWITCH 16384–32768. Закомментированные строки не в счёт: в штатной конфигурации
# параметры стоят именно так, и значение из комментария FreeSWITCH не применяет.
RTP_START=16384
RTP_END=32768
for conf in /etc/freeswitch /usr/local/freeswitch/etc/freeswitch; do
  switch_conf="${conf}/autoload_configs/switch.conf.xml"
  if [ -f "$switch_conf" ]; then
    start="$(grep -v '<!--' "$switch_conf" | sed -nE 's/.*name="rtp-start-port"[[:space:]]+value="([0-9]+)".*/\1/p' | head -1)"
    end="$(grep -v '<!--' "$switch_conf" | sed -nE 's/.*name="rtp-end-port"[[:space:]]+value="([0-9]+)".*/\1/p' | head -1)"
    RTP_START="${start:-$RTP_START}"
    RTP_END="${end:-$RTP_END}"
    break
  fi
done

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for port in $SSH_PORTS; do
  ufw allow "${port}/tcp" comment 'SSH' >/dev/null
done
ufw allow 5060/udp comment 'SIP' >/dev/null
ufw allow 5060/tcp comment 'SIP' >/dev/null
ufw allow "${RTP_START}:${RTP_END}/udp" comment 'RTP' >/dev/null
if [ "$PUBLIC_SITE" = yes ]; then
  ufw allow 80/tcp comment 'сайт' >/dev/null
  ufw allow 443/tcp comment 'сайт' >/dev/null
fi
ufw --force enable >/dev/null
ufw status verbose

step "Сайт nginx"
# Сайты порождаются из шаблонов при каждом запуске: правка шаблона доезжает до сервера
# повторной подготовкой, а не руками. Поэтому сертификат выпускается `certbot certonly`
# и сайт certbot не правит — иначе следующая подготовка стёрла бы его правки вместе с https.
# Метки подставляются только вне комментариев: шаблон называет их в шапке, а подстановка
# для https многострочная — её продолжение вышло бы из комментария директивами вне server.
render_site() {
  sed -e "/^[[:space:]]*#/!{s|@@LISTEN@@|${SITE_LISTEN}|;s|@@SERVER_NAME@@|${SITE_NAME}|g}" "$1" \
    >"/etc/nginx/sites-available/$2"
  ln -sfn "/etc/nginx/sites-available/$2" "/etc/nginx/sites-enabled/$2"
}
reload_nginx() {
  nginx -t
  systemctl enable nginx >/dev/null 2>&1
  systemctl reload-or-restart nginx
}
# Штатный сайт слушает 80 на всех адресах и показывал бы наружу приветствие nginx.
rm -f /etc/nginx/sites-enabled/default

if [ "$PUBLIC_SITE" = no ]; then
  rm -f /etc/nginx/sites-enabled/zvonix-acme
  render_site "$SITE_TEMPLATE" zvonix
  reload_nginx
else
  install -d -m 0755 "$ACME_ROOT"
  render_site "$ACME_TEMPLATE" zvonix-acme
  if [ ! -s "${CERT_DIR}/fullchain.pem" ]; then
    # Прежний сайт (например, туннель) не трогается, пока сертификата нет: не выпустится —
    # сервер останется таким, каким был.
    reload_nginx
    step "Сертификат ${SITE_NAME}"
    # Письма об истечении Let's Encrypt не рассылает с 2025 года, а продление автоматическое —
    # адрес почты ему не нужен.
    certbot certonly --webroot -w "$ACME_ROOT" -d "$SITE_NAME" \
      --non-interactive --agree-tos --register-unsafely-without-email \
      --deploy-hook 'systemctl reload nginx' \
      || die "Let's Encrypt не выпустил сертификат для ${SITE_NAME}. Обычно это запись DNS: A (и AAAA, если есть) должна указывать на этот сервер, а новая запись расходится до часа. Сайт остался прежним; поправьте и запустите установку снова"
  fi
  render_site "$SITE_TEMPLATE" zvonix
  reload_nginx
  # Продление — таймер пакета certbot, дважды в сутки; сайт на 80 для него остаётся.
  systemctl enable --now certbot.timer >/dev/null 2>&1 \
    || echo "ВНИМАНИЕ: таймер certbot.timer не включился — сертификат не будет продлеваться" >&2
fi

if [ "$ADDRESS_CHANGED" = yes ]; then
  # Процессы читают окружение при старте. Службы ставит выкладка: до первой их ещё нет,
  # а try-restart незнакомой службы — ошибка.
  for unit in zvonix-api zvonix-worker zvonix-web; do
    if systemctl cat "$unit" >/dev/null 2>&1; then
      systemctl try-restart "$unit"
    fi
  done
fi

node -v
psql --version
redis-server --version
nginx -v
echo
echo "Кабинет: ${WEB_ADDRESS}"
echo "SETUP_OK. Дальше: токен в ${GITHUB_ENV_FILE}, выпуск — zvonix-deploy <метка> (deploy/README.md)"
