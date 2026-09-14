#!/usr/bin/env bash
# Подготовка сервера площадки (ADR-0049). Запускается от root; повторный запуск создаёт
# недостающее и не трогает уже заданное — окружение и секреты не переписываются.
#
#   server-setup.sh [адрес кабинета]
#     http://localhost:8080   по умолчанию — стенд, кабинет через SSH-туннель
#     https://cp.example.ru   домен — сайт на 80, сертификат выпускается отдельно
#
# Ставит Node 22, PostgreSQL 16, Redis 7 и nginx, заводит пользователя zvonix, базу
# и секреты, включает файрвол. Панели управления нет: сервер описан этим скриптом.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

WEB_ADDRESS="${1:-http://localhost:8080}"
ETC=/etc/zvonix

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "нужны права root"

# Адрес кабинета разбирается до любых изменений: ошибка в нём не должна оставить сервер
# настроенным наполовину.
case "$WEB_ADDRESS" in
  http://localhost:* | http://127.0.0.1:*)
    SITE_PORT="${WEB_ADDRESS##*:}"
    SITE_PORT="${SITE_PORT%%/*}"
    [[ "$SITE_PORT" =~ ^[0-9]{2,5}$ ]] || die "порт в адресе ${WEB_ADDRESS} недопустим"
    SITE_LISTEN="listen 127.0.0.1:${SITE_PORT};"
    SITE_NAME="_"
    PUBLIC_SITE=no
    ;;
  https://*)
    SITE_NAME="${WEB_ADDRESS#https://}"
    SITE_NAME="${SITE_NAME%%/*}"
    [[ "$SITE_NAME" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "домен в адресе ${WEB_ADDRESS} недопустим"
    SITE_LISTEN='listen 80;\n    listen [::]:80;'
    PUBLIC_SITE=yes
    ;;
  *)
    die "адрес кабинета — http://localhost:<порт> для туннеля или https://<домен>"
    ;;
esac
SITE_TEMPLATE="$(dirname "$0")/nginx/zvonix.conf"
[ -f "$SITE_TEMPLATE" ] || die "нет ${SITE_TEMPLATE} — запускайте из каталога deploy/ целиком"

# shellcheck source=/dev/null
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "ВНИМАНИЕ: проверено на Ubuntu 24.04, здесь ${PRETTY_NAME:-неизвестно}" >&2

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
ENV_FILE="${ETC}/zvonix.env"
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
# Адрес кабинета в письмах.
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
  echo "${ENV_FILE} уже есть — не трогаю"
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
chown root:root "$GITHUB_ENV_FILE"
chmod 0600 "$GITHUB_ENV_FILE"

if [ -f "$(dirname "$0")/deploy.sh" ]; then
  install -m 0755 "$(dirname "$0")/deploy.sh" /usr/local/sbin/zvonix-deploy
fi

step "Сайт nginx"
# Сайт порождается из шаблона при каждом запуске: правка шаблона доезжает до сервера
# повторной подготовкой, а не руками.
sed -e "s|@@LISTEN@@|${SITE_LISTEN}|" -e "s|@@SERVER_NAME@@|${SITE_NAME}|" "$SITE_TEMPLATE" \
  >/etc/nginx/sites-available/zvonix
ln -sfn /etc/nginx/sites-available/zvonix /etc/nginx/sites-enabled/zvonix
# Штатный сайт слушает 80 на всех адресах и показывал бы наружу приветствие nginx.
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload-or-restart nginx

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

node -v
psql --version
redis-server --version
nginx -v
echo
if [ "$PUBLIC_SITE" = yes ]; then
  echo "Сертификат: apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d ${SITE_NAME}"
fi
echo "SETUP_OK. Дальше: токен в ${GITHUB_ENV_FILE}, выпуск — zvonix-deploy <метка> (deploy/README.md)"
