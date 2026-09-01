# Zvonix

Площадка терминации исходящих голосовых вызовов через GSM-шлюзы. Службы такси звонят,
вызов уходит на шлюз партнёра (физлицо с SIM и GOIP или телефоном на Android), с баланса
клиента списывается стоимость, партнёр получает долю, платформа — комиссию.

## Быстрый старт

Разработка ведётся в **WSL2 / Ubuntu 24.04** ([ADR-0007](docs/adr/0007-lokalnaya-sreda.md)).
Репозиторий должен лежать в файловой системе WSL, а не на `/mnt/*` — иначе всё работает
заметно медленнее.

```bash
pnpm install
cp .env.example .env        # заполнить значения
pnpm db:migrate
pnpm dev
```

Полная проверка перед отправкой изменений:

```bash
bash scripts/check.sh
```

Требуется: Node.js 22, pnpm 9, PostgreSQL 16, Redis 7.

## Структура

```
apps/api      NestJS: API, маршрутизация, доменные модули
apps/web      Next.js: админка, кабинеты клиента и партнёра
apps/worker   BullMQ: сверка CDR, выплаты, агрегации
apps/esl      Потребитель событий FreeSWITCH
apps/agent    Агент узла АТС
packages/     shared, db, config, logger
node/         Конфигурация FreeSWITCH и установка узла
android/      Приложение партнёра (Kotlin)
```

## Документация

- [CLAUDE.md](CLAUDE.md) — правила работы с кодовой базой и карта проекта
- [docs/DOMAIN.md](docs/DOMAIN.md) — сущности, связи, инварианты
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — компоненты и потоки данных
- [docs/GLOSSARY.md](docs/GLOSSARY.md) — доменные термины
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md) — ветки, коммиты, именование
- [docs/BACKLOG.md](docs/BACKLOG.md) — что должно быть в системе
- [docs/adr/](docs/adr/) — принятые архитектурные решения
- [TASKS.md](TASKS.md) — текущее состояние работ

## Окружения

| Окружение   | ОС                |
|-------------|-------------------|
| Разработка  | WSL2 Ubuntu 24.04 |
| Production  | Ubuntu            |
