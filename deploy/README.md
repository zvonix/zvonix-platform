# Выкладка площадки

Решение и его причины — [ADR-0049](../docs/adr/0049-vykladka-ploshchadki.md). Здесь — порядок
действий. Панели управления нет: сервер описан скриптами этого каталога.

> **Не проверено на живом сервере.** Скрипты написаны по заготовкам, которыми тестовый стенд
> поднимался 2026-09-13, но `deploy.sh`, `server-setup.sh` и `release.yml` в этом виде ещё
> не запускались. Состояние — в [TASKS.md](../TASKS.md), «Первый живой звонок».

## Что где

| В репозитории | На сервере |
|---|---|
| [deploy.sh](deploy.sh) | `/usr/local/sbin/zvonix-deploy` — обновляется каждым выпуском |
| [server-setup.sh](server-setup.sh) | запускается при подготовке; повторный запуск безопасен |
| [systemd/](systemd/) | `/etc/systemd/system/zvonix-{api,worker,web}.service` |
| [nginx/zvonix.conf](nginx/zvonix.conf) | шаблон `/etc/nginx/sites-available/zvonix` |
| [scripts/release-pack.mjs](../scripts/release-pack.mjs), [release.yml](../.github/workflows/release.yml) | — архив собирает GitHub Actions |

| Путь на сервере | Что там |
|---|---|
| `/opt/zvonix/releases/<метка>-<время>` | выпуски, хранятся пять последних |
| `/opt/zvonix/current`, `/opt/zvonix/previous` | ссылки на работающий и предыдущий |
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

```bash
git tag v0.1.0 && git push origin v0.1.0     # на машине разработчика
```

GitHub Actions («Release») прогоняет полную проверку и кладёт архив в GitHub Releases.
Затем на сервере:

```bash
sudo zvonix-deploy v0.1.0      # последняя строка: DEPLOY_OK v0.1.0
sudo zvonix-deploy --rollback  # вернуть предыдущий выпуск; миграции остаются
```

Не поднялся новый выпуск — скрипт сам возвращает прежний и называет это последней строкой.

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

## Первый администратор

Пароль не должен попасть ни в историю оболочки, ни в список процессов:

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
