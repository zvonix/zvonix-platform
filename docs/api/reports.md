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

## `GET /client/statement`, `GET /partner/statement` — акт и выписка за месяц

Основание — [ADR-0069](../adr/0069-akt-i-vypiska-za-mesyac.md). Параметры: `month` — `ГГГГ-ММ`
(обязателен; не старше 2020 года, будущий месяц — `400`), `offset` — как у сводок. Месяц считается
по местному времени человека. Кабинет клиента / кабинет партнёра; чужая роль — `403`.

```json
{ "client": { "name": "Такси «Волна»" }, "month": "2026-09", "from": "…", "to": "…",
  "partial": false,
  "totals": { "calls": 40, "answered": 31, "talk_seconds": 5400, "spent": "812.5" },
  "series": [ { "day": "2026-09-02", "calls": 3, … } ],
  "breakdowns": { "operator": [ … ], "channel": [ … ] },
  "opening_balance": "100", "closing_balance": "287.5", "charged": "812.5",
  "movements": [ { "at": "…", "kind": "deposit", "description": "…", "amount": "1000" } ] }
```

У партнёра вместо `client` — `partner`, вместо `spent` — `earned`, разрезы `operator`, `gateway`, `sim`.
`series` — только сутки, в которые были вызовы. `partial: true` — месяц не закончен, итоги и
конечный остаток на сейчас. `movements` — всё, кроме списаний за вызовы, построчно; `charged` —
списания (у партнёра — начисления) за вызовы **по проводкам периода**. Остаток сходится:
`opening_balance + движение − charged = closing_balance`. Вызов, начавшийся в последние минуты месяца,
входит в `totals` этого месяца, а проводка по нему — в следующий: `charged` может отличаться от
суммы по вызовам (ADR-0069, п. 4). Клиент не видит партнёра, партнёр — клиента (ADR-0014).

## Как читать

- **Доля состоявшихся (ASR)** = `answered / calls`. **Средний разговор (ACD)** =
  `talk_seconds / answered`. Кабинет считает их сам.
- Период вне списка — `400`.
