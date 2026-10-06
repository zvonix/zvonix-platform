# Обновление площадки из кабинета

Обоснование и границы — [ADR-0074](../adr/0074-obnovlenie-iz-adminki.md). Все адреса — только `admin`.

API **не запускает** выкладку: он кладёт заявку в каталог обмена (`UPDATER_DIR`, на сервере
`/var/lib/zvonix-updater`), а выкладку делает служба `zvonix-updater` от root. Состояние и журнал — файлы этой службы.
Нет каталога обмена — `available: false`, заявки отвечают `409`.

## `GET /updates`

```json
{
  "available": true,
  "current": { "version": "v0.1.70", "commit": "…", "builtAt": "…" },
  "releases_fetched_at": "2026-10-06T10:00:00+00:00",
  "releases": [{ "tag": "v0.1.71", "name": "…", "published_at": "…", "prerelease": false, "notes": "…" }],
  "queue": [{ "id": "<uuid>", "action": "deploy", "tag": "v0.1.71", "by": "admin@…", "requested_at": "…" }],
  "runs": [{ "id": "<uuid>", "action": "deploy", "tag": "v0.1.71", "by": "…", "requested_at": "…",
             "status": "running|succeeded|failed", "started_at": "…", "finished_at": null, "exit_code": null }]
}
```

`queue` — заявки, которые служба ещё не приняла (их можно отменить). `runs` — принятые, новые первыми, не больше 15.
`current.version` — `null`, если сборка не из выпуска.

## `POST /updates/deploy` · `{ "tag": "v0.1.71" }`

`202` и `{ "request": {…} }`. Метка — только из `releases` (иначе `404`), по шаблону выкладки (иначе `400`),
не текущая (`409`). Пока есть ждущая или идущая выкладка (в том числе откат), новая — `409`.

## `POST /updates/rollback`

`202`. Возврат на предыдущий выпуск (`zvonix-deploy --rollback`); миграции базы не откатываются.

## `POST /updates/refresh`

`202`. Просит службу заново спросить GitHub о выпусках; очереди выкладок не мешает. Служба обновляет список и сама
раз в 10 минут.

## `POST /updates/:id/cancel`

`204`. Отмена заявки, которую служба ещё не приняла. Принятая выкладка не отменяется: `409`.

## `GET /updates/:id/log?offset=0`

```json
{ "text": "=== Копия базы\n…", "next_offset": 1234, "run": { "id": "…", "status": "running", … } }
```

Журнал выкладки с байтового смещения `offset`, до 64 КБ за ответ. Пока выкладка идёт, недописанная строка не отдаётся
(ждёт перевода строки). Кабинет опрашивает раз в секунду и подставляет `next_offset` в следующий запрос; шаги
выкладки — строки журнала вида `=== Название`. `404` — такого обновления нет, `400` — идентификатор не UUID.

Журнал действий: `update.deploy_requested`, `update.rollback_requested`, `update.refresh_requested`, `update.cancelled`
(сущность `update`, идентификатор заявки).
