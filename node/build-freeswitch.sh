#!/usr/bin/env bash
# Сборка FreeSWITCH 1.10.12 из исходников на узле — для первого узла площадки, пока свой
# репозиторий пакетов (ADR-0045) не собран. Запускается от root на Ubuntu 24.04:
#
#   sudo bash node/build-freeswitch.sh
#
# Почему из исходников: в репозиториях Ubuntu пакета нет, а готовые бинарники SignalWire
# раздаёт только по своему токену (проверено 2026-09-09). Рецепт восстановлен по сборке
# на прежнем тестовом сервере — он пропал вместе с переустановкой сервера, отсюда и файл.
#
# Повторный запуск безопасен: собранное не пересобирается. Уже стоит FreeSWITCH — скрипт
# только проверяет службу. Дальше — команда установки узла из кабинета (node/README.md):
# она найдёт FreeSWITCH и настроит его.
#
# Длительность на 1 ядре — полчаса–час; память — от 1 ГБ с подкачкой (её заводит
# deploy/server-setup.sh). Сборка идёт в /usr/src, установка — в /usr/local/freeswitch.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PREFIX=/usr/local/freeswitch
SRC=/usr/src
JOBS="$(nproc)"

# Версии закреплены: сборка должна повторяться, а не брать то, что лежит в ветке сегодня.
SOFIA_TAG=v1.13.17
LIBKS_TAG=v2.0.7
SPANDSP_COMMIT=0d2e6ac65e0e8f53d652665a743015a88bf048d4
FREESWITCH_TAG=v1.10.12

die() {
  echo "Ошибка: $*" >&2
  exit 1
}
step() { printf '\n=== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "нужны права root"
# shellcheck source=/dev/null
. /etc/os-release
[ "${VERSION_ID:-}" = "24.04" ] || echo "ВНИМАНИЕ: рецепт проверен на Ubuntu 24.04, здесь ${PRETTY_NAME:-неизвестно}" >&2

if [ ! -x "${PREFIX}/bin/freeswitch" ]; then
  step "Пакеты для сборки"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    build-essential automake autoconf libtool libtool-bin pkg-config cmake git ca-certificates \
    yasm libssl-dev zlib1g-dev libncurses-dev libexpat1-dev bison \
    libjpeg-dev libcurl4-openssl-dev libpcre3-dev libspeex-dev libspeexdsp-dev libsqlite3-dev \
    libedit-dev libldns-dev libopus-dev libsndfile1-dev libtiff-dev uuid-dev

  # Собранные библиотеки ложатся в /usr/local — configure FreeSWITCH должен их видеть.
  export PKG_CONFIG_PATH="/usr/local/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

  step "sofia-sip ${SOFIA_TAG} — стек SIP для mod_sofia"
  if [ ! -f /usr/local/lib/libsofia-sip-ua.so ]; then
    rm -rf "${SRC}/sofia-sip"
    git clone -q --depth 1 -b "$SOFIA_TAG" https://github.com/freeswitch/sofia-sip.git "${SRC}/sofia-sip"
    (
      cd "${SRC}/sofia-sip"
      ./bootstrap.sh -j
      ./configure --prefix=/usr/local --disable-stun --without-doxygen
      make -j"$JOBS"
      make install
    )
    ldconfig
  fi

  step "libks ${LIBKS_TAG} — нужна configure FreeSWITCH 1.10"
  if [ ! -f /usr/local/lib/libks2.so ] && [ ! -f /usr/lib/libks2.so ]; then
    rm -rf "${SRC}/libks"
    # Без --depth: CMakeLists берёт версию из истории git, и на мелкой копии падает
    # с «string sub-command REPLACE requires four arguments» (2026-09-09).
    git clone -q -b "$LIBKS_TAG" https://github.com/signalwire/libks.git "${SRC}/libks"
    (
      cd "${SRC}/libks"
      cmake . -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_BUILD_TYPE=Release
      make -j"$JOBS"
      make install
    )
    ldconfig
  fi

  step "spandsp — configure FreeSWITCH требует её всегда, даже без модуля факсов"
  if ! pkg-config --exists spandsp; then
    rm -rf "${SRC}/spandsp"
    git clone -q https://github.com/freeswitch/spandsp.git "${SRC}/spandsp"
    (
      cd "${SRC}/spandsp"
      git checkout -q "$SPANDSP_COMMIT"
      ./bootstrap.sh
      ./configure --prefix=/usr/local
      make -j"$JOBS"
      make install
    )
    ldconfig
  fi

  step "FreeSWITCH ${FREESWITCH_TAG}"
  if [ ! -d "${SRC}/freeswitch" ]; then
    git clone -q --depth 1 -b "$FREESWITCH_TAG" https://github.com/signalwire/freeswitch.git "${SRC}/freeswitch"
  fi
  (
    cd "${SRC}/freeswitch"
    # Только то, что нужно узлу: SIP, маршрут по HTTP (mod_xml_curl), CDR (mod_json_cdr),
    # события (mod_event_socket), запись, служебные приложения. Меньше модулей — быстрее
    # сборка и меньше поверхность. mod_lua не собирается: заголовков Lua в системе нет.
    #
    # Добавлены по решению владельца 2026-09-22:
    #   mod_spandsp — распознавание тонов и сигналов сети: ложный ответ шлюза (минуты
    #                 без разговора) и честная причина недозвона; клавиши, переданные звуком;
    #   mod_opus    — кодек приложения партнёра на Android (ADR-0012) и софтфонов;
    #   mod_timerfd — точный таймер Linux для потока звука;
    #   mod_hash    — счётчик на узле: вторая страховка «одна SIM — один вызов».
    # Собрать — не значит включить: загрузку и настройку делает установщик узла.
    cat >modules.conf <<'MODULES'
applications/mod_commands
applications/mod_dptools
applications/mod_hash
applications/mod_spandsp
applications/mod_expr
applications/mod_esf
applications/mod_fsv
applications/mod_valet_parking
applications/mod_httapi
codecs/mod_g723_1
codecs/mod_g729
codecs/mod_opus
codecs/mod_amr
codecs/mod_b64
codecs/mod_h26x
dialplans/mod_dialplan_xml
endpoints/mod_loopback
endpoints/mod_sofia
event_handlers/mod_json_cdr
event_handlers/mod_event_socket
formats/mod_local_stream
formats/mod_native_file
formats/mod_sndfile
formats/mod_tone_stream
loggers/mod_console
loggers/mod_logfile
loggers/mod_syslog
say/mod_say_en
timers/mod_timerfd
xml_int/mod_xml_curl
MODULES
    ./bootstrap.sh -j
    ./configure --prefix="$PREFIX" --enable-portable-snapshot \
      --disable-libvpx --without-erlang --without-python --without-python3
    make -j"$JOBS"
    make install
  )
else
  echo "FreeSWITCH уже собран в ${PREFIX} — сборка пропущена"
fi

step "Служба freeswitch"
id freeswitch >/dev/null 2>&1 \
  || useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin freeswitch
chown -R freeswitch:freeswitch "$PREFIX"
# Установщик узла ищет FreeSWITCH через `command -v freeswitch` и выводит каталог
# конфигурации из пути к исполняемому файлу (ADR-0045, ревизия 2026-09-14).
ln -sf "${PREFIX}/bin/freeswitch" /usr/local/bin/freeswitch
ln -sf "${PREFIX}/bin/fs_cli" /usr/local/bin/fs_cli

cat >/etc/systemd/system/freeswitch.service <<UNIT
# Порождается node/build-freeswitch.sh — правится там, а не здесь.
[Unit]
Description=FreeSWITCH
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=freeswitch
Group=freeswitch
ExecStart=${PREFIX}/bin/freeswitch -ncwait -nonat -rp
ExecReload=${PREFIX}/bin/fs_cli -x reloadxml
Restart=on-failure
RestartSec=5
LimitNOFILE=100000
LimitNPROC=60000

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable freeswitch >/dev/null 2>&1
systemctl restart freeswitch

for attempt in $(seq 1 30); do
  fs_cli -x status >/dev/null 2>&1 && break
  sleep 2
done
fs_cli -x status | head -3 || die "FreeSWITCH не ответил fs_cli — journalctl -u freeswitch"
echo "FREESWITCH_OK $(freeswitch -version | head -1)"
