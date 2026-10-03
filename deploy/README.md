# Выкладка площадки

Решение и его причины — [ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md). Здесь — порядок
действий. Панели управления нет: сервер описан скриптами этого каталога.

> **Проверено на живом сервере 2026-09-22** (выпуск `v0.1.0`): `release.yml`, `server-setup.sh`
> и `zvonix-deploy --archive`; строка установки с `v0.1.2` — скачивание выпуска по токену,
> копия базы, миграции, код первого запуска
> ([ADR-0050](../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)). **Ещё не запускались
> живьём:** домен с сертификатом ([ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md), ревизия
> «домен и https») и переспрашивающий вопрос адреса.
> Состояние — в [TASKS.md](../TASKS.md).

## Установка одной командой

На новом сервере Ubuntu 24.04 — или на уже подготовленном: все шаги повторяемы. Под root.

**Строка с токеном и адресом внутри** (решение владельца 2026-09-30 —
[ADR-0050](../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md), ревизия). Вместо
`ВАШ_ТОКЕН` подставьте токен, вместо `cp.zvonix.com` — адрес кабинета. Строка начинается
с **пробела**: в Ubuntu такая строка не попадает в историю команд.

```bash
 (set -o pipefail; export GITHUB_TOKEN='ВАШ_ТОКЕН'; curl -fsSL -H @<(printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN") -H 'Accept: application/vnd.github.raw' https://api.github.com/repos/zvonix/zvonix-platform/contents/deploy/install.sh | bash -s -- cp.zvonix.com) || echo 'Установка не выполнена: проверьте токен и доступ к репозиторию'
```

Что в ней сделано, чтобы токен не утёк:

- строка идёт в подоболочке: токен живёт только в ней, и после установки в сессии его нет;
- `curl` получает токен файлом-дескриптором `@<(…)`, а не аргументом: аргументы видны
  в списке процессов;
- `pipefail` и `||`: неверный токен даёт ошибку «Установка не выполнена…», а не молчаливый
  успех — без них `bash` получил бы пустой ввод и вышел бы с кодом 0;
- адрес в конце — вопроса об адресе нет; другой домен позже — та же строка с новым адресом.

**Остаточный риск:** токен виден тому, кто читает окно терминала, буфер обмена и файл, где
строка записана. Поэтому токен — только с правом чтения содержимого репозитория и со сроком
жизни (раздел «Токен GitHub» ниже), а файл с готовой строкой лежит вне git (`start.md` —
в `.gitignore`). После установки токен остаётся на сервере в `github.env`: он нужен
выкладкам.

**Без токена в строке** — прежний способ, токен спрашивается скрытым вводом:

```bash
read -rsp 'Токен GitHub: ' GITHUB_TOKEN && echo && export GITHUB_TOKEN && \
curl -fsSL -H @<(printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN") \
  -H 'Accept: application/vnd.github.raw' \
  https://api.github.com/repos/zvonix/zvonix-platform/contents/deploy/install.sh \
| sudo --preserve-env=GITHUB_TOKEN bash -s --; unset GITHUB_TOKEN
```

Установка спросит **адрес кабинета** — любой домен, чья запись A указывает на сервер
(раздел «Домен» ниже), — и переспросит: «Кабинет будет на https://cp.zvonix.com. Верно?».
Пустой ответ тоже переспрашивается: на новом сервере — «Ставить без домена?» (кабинет тогда
только через SSH-туннель), на подготовленном — «Оставить записанный?». Адрес можно дать
и сразу, в конце строки, — тогда вопроса нет: `bash -s -- cp.zvonix.com`. Другой домен
позже — та же строка с новым адресом: сертификат выпустится на него.
Токен — раздел «Токен GitHub» ниже. Ввод скрыт, и в аргументы команд токен не попадает:
`curl` получает его через дескриптор, скрипт — переменной окружения.

[install.sh](install.sh) берёт последний выпуск, готовит сервер его же скриптами
(`server-setup.sh` записывает токен в `github.env`) и выкладывает выпуск. Пока
администратора нет, выкладка печатает **код первого запуска** — дальше раздел «Первый вход».

## Домен

До установки с доменом его запись в DNS должна указывать на сервер. У регистратора домена
заводится одна запись:

| Тип | Имя | Значение |
|---|---|---|
| A | `cp` | адрес сервера |

Запись AAAA для этого имени не заводится, если у сервера нет своего IPv6: Let's Encrypt
проверяет по ней первой. Новая запись расходится от минут до часа; дошла ли она —
`getent hosts cp.zvonix.com` на сервере.

Подготовка сама проверяет DNS, открывает 80 и 443, выпускает сертификат Let's Encrypt
и перенаправляет http на https. Сертификат продлевается таймером `certbot.timer`.
Не выпустился — сервер остаётся каким был, а подготовка называет причину.

## Что где

| В репозитории | На сервере |
|---|---|
| [install.sh](install.sh) | не ставится — его скачивает и запускает строка установки |
| [deploy.sh](deploy.sh) | `/usr/local/sbin/zvonix-deploy` — обновляется каждым выпуском |
| [server-setup.sh](server-setup.sh) | запускается при подготовке; повторный запуск безопасен |
| [systemd/](systemd/) | `/etc/systemd/system/zvonix-{api,worker,web}.service` |
| [nginx/zvonix.conf](nginx/zvonix.conf) | шаблон `/etc/nginx/sites-available/zvonix` — кабинет и API |
| [nginx/zvonix-acme.conf](nginx/zvonix-acme.conf) | шаблон `/etc/nginx/sites-available/zvonix-acme` — порт 80 при домене: проверка Let's Encrypt и перенаправление на https |
| [scripts/release-pack.mjs](../scripts/release-pack.mjs), [release.yml](../.github/workflows/release.yml) | — архив собирает GitHub Actions |

| Путь на сервере | Что там |
|---|---|
| `/opt/zvonix/releases/<метка>-<время>` | выпуски, хранятся пять последних |
| `/opt/zvonix/current`, `/opt/zvonix/previous` | ссылки на работающий и предыдущий |
| `/var/lib/zvonix/recordings` | записи разговоров ([ADR-0063](../docs/adr/0063-hranilishche-zapisey-na-diske.md)): создаёт systemd (`StateDirectory`), выкладка не стирает, **копий нет**; срок хранения — настройка «Срок хранения записей» (30 суток) в кабинете ([ADR-0065](../docs/adr/0065-sostoyanie-serverov-i-istoriya.md)) |
| `/var/backups/zvonix/<метка>-<время>.dump` | копия базы перед миграциями каждой выкладки, пять последних; `postgres 0700` |
| `/etc/zvonix/zvonix.env` | окружение площадки, `root:zvonix 0640`; выкладкой не переписывается |
| `/etc/zvonix/secrets.env` | пароль базы и `SECRET_KEY`, только root |
| `/etc/zvonix/github.env` | репозиторий и токен для выпусков, только root |
| `/etc/letsencrypt/live/<домен>/` | сертификат кабинета; продлевает `certbot.timer` |

## Подготовка сервера

1. **Снимок VPS.** Узел АТС на той же машине — от 2 ядер и 2–4 ГБ памяти, Ubuntu 24.04.
2. Скопировать каталог `deploy/` на сервер и выполнить:
   ```bash
   sudo bash deploy/server-setup.sh                        # адрес — записанный; на новом сервере туннель
   sudo bash deploy/server-setup.sh cp.zvonix.com          # домен: сертификат и https
   sudo bash deploy/server-setup.sh http://localhost:8080  # обратно на туннель
   ```
   Скрипт ставит Node 22, PostgreSQL 16, Redis 7 и nginx, заводит базу и секреты, собирает
   сайт из шаблона и включает файрвол. Повторный запуск не трогает окружение и секреты,
   кроме адреса кабинета (`WEB_BASE_URL`), а сайт и правила файрвола обновляет.
3. **Токен GitHub** — fine-grained: *Resource owner* → организация, которой принадлежит
   репозиторий (не личный аккаунт: с ним приватный репозиторий организации отвечает `404`),
   *Only select repositories* → репозиторий площадки, *Repository permissions* →
   *Contents: Read-only*, срок действия — не бессрочный.
   Вписать в `/etc/zvonix/github.env`:
   ```
   GITHUB_REPOSITORY=zvonix/zvonix-platform
   GITHUB_TOKEN=github_pat_…
   ```

## Защита сервера

Подготовка заводит сама:

- **подкачку** `/swapfile` 2 ГБ, если подкачки нет вовсе (`vm.swappiness = 10`). Без неё
  сервер с 1 ГБ памяти при нехватке убивает процессы, а с ними и звонки;
- **fail2ban** — тюрьма `sshd`: 5 неудач за 10 минут дают час блокировки
  (`/etc/fail2ban/jail.d/zvonix.conf`). Вход с первой попытки блокировка не задевает;
- **`X11Forwarding no`** — `/etc/ssh/sshd_config.d/10-zvonix.conf`, проверяется `sshd -t`
  до перечитывания.

Вход root по паролю подготовка **не** отключает: без ключа у владельца это запертый сервер.
Сначала ключ (PuTTYgen, открытая часть — в `/root/.ssh/authorized_keys`), вход по нему,
и только потом `PasswordAuthentication no`.

Обновления безопасности ставит `unattended-upgrades` из образа Ubuntu. Всё накопленное
в образе — один раз руками, с перезагрузкой: сначала `apt-get -o DPkg::Lock::Timeout=900
full-upgrade` (блокировку dpkg в первые минуты держит `unattended-upgrades`), затем
`systemctl reboot`. Площадка поднимается сама — замер 2026-09-22: около минуты.

## Порты

Файрвол включает `server-setup.sh`: входящее закрыто всё, кроме таблицы.

| Порт | Открыт? | Зачем |
|---|---|---|
| порт SSH | да | узнаётся у `sshd` и разрешается первым — доступ не отрежется |
| 5060/udp, 5060/tcp | да | SIP: регистрация GOIP и вызовы |
| RTP, по умолчанию 16384–32768/udp | да | голос; диапазон берётся из конфигурации FreeSWITCH |
| 80, 443 | только с доменом | сайт |
| 5080 | нет | внешний профиль FreeSWITCH; открыть — `ufw allow 5080/udp`, если понадобится |
| 8021 | нет | управление FreeSWITCH |
| 8000, 3000 | нет | API и кабинет — только через nginx |
| 5432, 6379 | нет | PostgreSQL и Redis |

## Выпуск

По шагам, с разбором миграций и копией базы перед выкладкой, — навык `/release`
([.claude/skills/release/SKILL.md](../.claude/skills/release/SKILL.md)). Коротко:

```bash
pnpm verify                                   # последний блок — «Можно выпускать» и метка
node scripts/migration-risk.mjs <база>        # что в новых миграциях теряет данные
git tag v0.1.0 && git push origin v0.1.0     # на машине разработчика
```

GitHub Actions («Release») прогоняет полную проверку и кладёт архив в GitHub Releases.
Затем на сервере:

```bash
sudo zvonix-deploy v0.1.0      # последняя строка: DEPLOY_OK v0.1.0
sudo zvonix-deploy --rollback  # вернуть предыдущий выпуск; миграции остаются
```

Не поднялся новый выпуск — скрипт сам возвращает прежний и называет это последней строкой.

Перед миграциями выкладка снимает **копию базы** — строка `копия базы: /var/backups/zvonix/…`
в выводе. Не снялась — выкладка останавливается до миграций. Откат возвращает код, но не базу;
данные, испорченные миграцией, возвращаются из копии — только решением владельца, с потерей
записанного после неё ([ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md), ревизия 2026-09-22):

```bash
sudo systemctl stop zvonix-api zvonix-worker zvonix-web
sudo -u postgres pg_restore --clean --if-exists -d zvonix /var/backups/zvonix/<файл>.dump
```

**Без GitHub** — архив собирается на Linux (кабинет везёт зависимости под систему сборки):

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm web:build
node scripts/release-pack.mjs v0.1.0         # release/zvonix-v0.1.0.tgz и .sha256
sudo zvonix-deploy --archive zvonix-v0.1.0.tgz
```

## Проверка после выкладки

С доменом — откуда угодно:

```bash
curl -fsS https://cp.zvonix.com/api/health/ready                         # {"status":"ok","database":"ok"}
curl -fsS -o /dev/null -w '%{http_code}\n' https://cp.zvonix.com/login   # 200
```

Без домена — те же запросы с сервера по `http://127.0.0.1:8080`, а кабинет со своей машины —
через туннель: `ssh -L 8080:127.0.0.1:8080 root@<сервер>`, затем `http://localhost:8080`.
В PuTTY то же самое: Connection → SSH → Tunnels, Source port `8080`,
Destination `127.0.0.1:8080`, Add.

## Первый вход

Пока на площадке нет администратора, выкладка перед строкой `DEPLOY_OK` печатает:

```
Первый запуск: администратора ещё нет.
  Кабинет:  http://localhost:8080/setup
  Код:      B4PR-3N3H-CCP5
  Действует до 2026-09-24 00:00 UTC.
```

Кабинет сам открывается на форме «Первый запуск»: код, почта, имя, пароль. Код живёт
от суток до двух; истёк — свежий печатает та же команда, что зовёт выкладка:

```bash
sudo -u zvonix sh -c 'set -a; . /etc/zvonix/zvonix.env; set +a; cd /opt/zvonix/current/apps/api && exec node dist/modules/identity/first-run-code.js'
```

Когда администратор есть, форма отвечает «первый запуск уже выполнен» — код больше ничего
не открывает ([ADR-0050](../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)).

**Без кабинета** — поддержка или администратор командой на сервере. Пароль не должен
попасть ни в историю оболочки, ни в список процессов:

```bash
read -rp 'Адрес: ' ADMIN_EMAIL && read -rsp 'Пароль: ' ADMIN_PASSWORD && echo
sudo -u zvonix env ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" sh -c \
  'set -a; . /etc/zvonix/zvonix.env; set +a; cd /opt/zvonix/current/apps/api && exec node dist/modules/identity/create-admin.js'
unset ADMIN_PASSWORD
```

## SIP-домен площадки

`SIP_REALM` в `/etc/zvonix/zvonix.env` — общий SIP-домен площадки, например `sip.zvonix.com`.
Он входит в хеш пароля каждого шлюза и каждой линии, поэтому задаётся **до выдачи первого
пароля**: смена потом означает перевыпуск всех. Подготовка его не пишет — без строки
действует заглушка `sip.zvonix.local`. После правки — `systemctl restart zvonix-api zvonix-worker`.

## Узел АТС на этой же машине

В кабинете: «Узлы» → завести узел → команда установки. Площадка на этом же сервере,
поэтому адрес в команде — `http://127.0.0.1:8000`, и установщик его принимает.
FreeSWITCH уже стоит — репозиторий пакетов не нужен
([ADR-0045](../docs/adr/0045-ustanovshchik-uzla.md), ревизии). Проверка после установки —
навык `node-live` и [node/README.md](../node/README.md).

**Узел обновляется вместе с площадкой.** `zvonix-deploy` после перехода на выпуск
приводит узел на этой машине к набору выпуска: конфигурация FreeSWITCH, правила
fail2ban, пульс, пароль ESL площадке. FreeSWITCH перезапускается, только если набор
изменился, и только когда на узле нет звонков. Подробно — [node/README.md](../node/README.md),
«Обновление узла». Отдельно, без выкладки: `zvonix-node-update`.

### Узел, установленный до тестового звонка

Тестовому звонку ([ADR-0055](../docs/adr/0055-testovyy-zvonok-s-sim.md)) нужен пароль ESL
узла, а установщик сообщает его площадке только с этой версии. Узлу, поставленному раньше,
его передают один раз под root на той же машине. Ключ узла берётся из его же конфигурации,
в аргументы процесса секреты не попадают:

```sh
CONF=/usr/local/freeswitch/etc/freeswitch/autoload_configs/xml_curl.conf.xml   # у пакета — /etc/freeswitch/…
CRED="$(sed -n 's/.*name="gateway-credentials" value="\([^"]*\)".*/\1/p' "$CONF" | head -1)"
PASS="$(sed -n 's/^password => //p' /etc/fs_cli.conf | head -1)"
BODY="$(umask 077 && mktemp)"; printf '{"password":"%s"}' "$PASS" >"$BODY"
printf 'user = "%s"\n' "$CRED" | curl -fsS -K - -X PUT -H 'Content-Type: application/json' \
  --data-binary "@$BODY" http://127.0.0.1:8000/node/esl; rm -f "$BODY"
```

Ответ `{"esl":"registered"}` — площадка может звонить через узел. С выпуска, где
появилось обновление узла, этот шаг делает `zvonix-deploy` сам.
