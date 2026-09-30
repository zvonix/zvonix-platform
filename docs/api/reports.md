# Сводки

Читающий модуль `reports` ([ADR-0059](../adr/0059-otchyoty-i-svodki.md)): вызовы и деньги
по суткам и по разрезам. Только чтение, схемы БД не меняет.

Параметры у всех:

| Параметр | Значение |
|---|---|
| `days` | период: `1` (сегодня), `7`, `30`, `90`; по умолчанию `7` |
| `offset` | часовой пояс в минутах к востоку от UTC (Красноярск — `420`); сутки считаются по нему |
| `by` | только у разреза; допустимые значения зависят от роли |

Деньги вызова — из его проводки `charge:<вызов>`: клиент — списано, партнёр — начислено,
системный счёт выручки — остаётся площадке. Вызов без проводки (отказ, 0 секунд) входит
в число вызовов, но не в деньги. Суммы — в рублях строкой, как везде.

## `GET /reports/overview` — `admin`, `support`

```json
{ "days": 7, "from": "…", "to": "…",
  "totals": { "calls": 3, "answered": 1, "talk_seconds": 60,
              "revenue": "11.5", "partner_cost": "10", "margin": "1.5" },
  "series": [ { "day": "2026-09-30", "calls": 3, … } ] }
```

`series` содержит **все** сутки периода, пустые — нулями.

## `GET /reports/breakdown?by=…` — `admin`, `support`

`by`: `client`, `partner`, `operator`, `channel`, `sim`, `gateway`. Ответ
`{ "rows": [ { "key", "name", "calls", "answered", "talk_seconds", "revenue",
"partner_cost", "margin" } ] }`, не больше 50 строк, по убыванию выручки. Вызов без SIM
или оператора — строка с `name: null`.

## `GET /client/reports/overview`, `GET /client/reports/breakdown` — кабинет клиента

Поля: `calls`, `answered`, `talk_seconds`, **`spent`**. Партнёра, закупки и маржи нет
([ADR-0014](../adr/0014-vybor-partnera-klientom.md)). Разрез `by`: `operator`, `channel`;
остальные — `400`.

## `GET /partner/reports/overview`, `GET /partner/reports/breakdown` — кабинет партнёра

Поля: `calls`, `answered`, `talk_seconds`, **`earned`**. Клиента, его цены и маржи нет.
Разрез `by`: `sim`, `gateway`, `operator`; остальные — `400`.

## Как читать

- **Доля состоявшихся (ASR)** = `answered / calls`. **Средний разговор (ACD)** =
  `talk_seconds / answered`. Кабинет считает их сам.
- Период вне списка — `400`.
