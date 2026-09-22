# Выкладка площадки

Решение и его причины — [ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md). Здесь — порядок
действий. Панели управления нет: сервер описан скриптами этого каталога.

> **Проверено на живом сервере 2026-09-22** (выпуск `v0.1.0`): `release.yml`, `server-setup.sh`
> и `zvonix-deploy --archive`. **Ещё не запускались живьём:** скачивание выпуска сервером
> по токену и установка одной командой
> ([ADR-0050](../docs/adr/0050-ustanovka-odnoy-komandoy-i-pervyy-vhod.md)).
> Состояние — в [TASKS.md](../TASKS.md).

## Установка одной командой

На новом сервере Ubuntu 24.04 — или на уже подготовленном: все шаги повторяемы. Под root:

```bash
read -rsp 'Токен GitHub: ' GITHUB_TOKEN && echo && export GITHUB_TOKEN && \
curl -fsSL -H @<(printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN") \
  -H 'Accept: application/vnd.github.raw' \
  https://api.github.com/repos/zvonix/zvonix-platform/contents/deploy/install.sh \
| sudo --preserve-env=GITHUB_TOKEN bash -s --; unset GITHUB_TOKEN
```

С доменом адрес кабинета добавляется в конце: `bash -s -- https://cp.example.ru`.
Токен — раздел «Токен GitHub» ниже. Ввод скрыт, и в аргументы команд токен не попадает:
`curl` получает его через дескриптор, скрипт — переменной окружения.

[install.sh](install.sh) берёт последний выпуск, готовит сервер его же скриптами
(`server-setup.sh` записывает токен в `github.env`) и выкладывает выпуск. Пока
администратора нет, выкладка печатает **код первого запуска** — дальше раздел «Первый вход».

## Что где

| В репозитории | На сервере |
|---|---|
| [install.sh](install.sh) | не ставится — его скачивает и запускает строка установки |
| [deploy.sh](deploy.sh) | `/usr/local/sbin/zvonix-deploy` — обновляется каждым выпуском |
| [server-setup.sh](server-setup.sh) | запускается при подготовке; повторный запуск безопасен |
| [systemd/](systemd/) | `/etc/systemd/system/zvonix-{api,worker,web}.service` |
| [nginx/zvonix.conf](nginx/zvonix.conf) | шаблон `/etc/nginx/sites-available/zvonix` |
| [scripts/release-pack.mjs](../scripts/release-pack.mjs), [release.yml](../.github/workflows/release.yml) | — архив собирает GitHub Actions |

| Путь на сервере | Что там |
|---|---|
| `/opt/zvonix/releases/<метка>-<время>` | выпуски, хранятся пять последних |
| `/opt/zvonix/current`, `/opt/zvonix/previous` | ссылки на работающий и предыдущий |
| `/var/backups/zvonix/<метка>-<время>.dump` | копия базы перед миграциями каждой выкладки, пять последних; `postgres 0700` |
| `/etc/zvonix/zvonix.env` | окружение площадки, `root:zvonix 0640`; выкладкой не переписывается |
| `/etc/zvonix/secrets.env` | пароль базы и `SECRET_KEY`, только root |
| `/etc/zvonix/github.env` | репозиторий и токен для выпусков, только root |

## Подготовка сервера

1. **Снимок VPS.** Узел АТС на той же машине — от 2 ядер и 2–4 ГБ памяти, Ubuntu 24.04.
2. Скопировать каталог `deploy/` на сервер и выполнить:
   ```bash
   sudo bash deploy/server-setup.sh                          # стенд: кабинет через SSH-туннель
   sudo bash deploy/server-setup.sh https://cp.example.ru    # когда есть домен
   ```
   Скрипт ставит Node 22, PostgreSQL 16, Redis 7 и nginx, заводит базу и секреты, собирает
   сайт из шаблона и включает файрвол. Повторный запуск не трогает окружение и секреты,
   а сайт и правила файрвола обновляет.
3. **Токен GitHub** — fine-grained: *Resource owner* → организация, которой принадлежит
   репозиторий (не личный аккаунт: с ним приватный репозиторий организации отвечает `404`),
   *Only select repositories* → репозиторий площадки, *Repository permissions* →
   *Contents: Read-only*, срок действия — не бессрочный.
   Вписать в `/etc/zvonix/github.env`:
   ```
   GITHUB_REPOSITORY=zvonix/zvonix-platform
   GITHUB_TOKEN=github_pat_…
   ```

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

С сервера:

```bash
curl -fsS http://127.0.0.1:8080/api/health/ready                         # {"status":"ok","database":"ok"}
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/login   # 200
```

Кабинет со своей машины — через туннель: `ssh -L 8080:127.0.0.1:8080 root@<сервер>`,
затем `http://localhost:8080`.

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

## Узел АТС на этой же машине

В кабинете: «Узлы» → завести узел → команда установки. Площадка на этом же сервере,
поэтому адрес в команде — `http://127.0.0.1:8000`, и установщик его принимает.
FreeSWITCH уже стоит — репозиторий пакетов не нужен
([ADR-0045](../docs/adr/0045-ustanovshchik-uzla.md), ревизии). Проверка после установки —
навык `node-live` и [node/README.md](../node/README.md).
