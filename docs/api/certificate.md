# Контракт: сертификат кабинета

Основание — [ADR-0083](../adr/0083-sertifikat-v-nastroykah.md). Только роль `admin`. Состояние читается из
каталога обмена службы обновления ([updates.md](updates.md)), действия — заявки ей же: API ничего не выпускает.

## `GET /certificate`

```json
{
  "available": true,
  "state": "ok",
  "checked_at": "2026-10-12T15:00:00+00:00",
  "domain": "cp.zvonix.com",
  "expected_names": ["cp.zvonix.com", "zvonix.com", "www.zvonix.com"],
  "covered_names": ["cp.zvonix.com", "zvonix.com", "www.zvonix.com"],
  "missing_names": [],
  "issuer": "Let's Encrypt",
  "not_before": "2026-10-11T13:24:18+00:00",
  "not_after": "2027-01-09T13:24:17+00:00",
  "days_left": 88,
  "auto_renew": true,
  "problem": null,
  "busy": false,
  "last_run": { "id": "…", "action": "cert-issue", "status": "succeeded", "finished_at": "…", "exit_code": 0 }
}
```

`state`: `ok`; `soon` — осталось 14 суток и меньше; `expired`; `incomplete` — не закрывает все ожидаемые имена;
`missing` — файла нет; `not_configured` — кабинет открыт без домена; `unknown` — служба ещё не читала сертификат
(`available: false`). `busy` — заявка на сертификат ждёт или выполняется. `auto_renew` — таймер `certbot.timer`
включён (`null` — прочитать не удалось).

## Действия

Все отвечают `202` и `{ "request": { "id", "action", … } }`; ход и журнал — `GET /updates/:id/log`.

| Запрос | Что делает |
|---|---|
| `POST /certificate/check` | перечитать сертификат сейчас; лёгкое действие, не мешает выкладке |
| `POST /certificate/issue` | выпустить или перевыпустить на все ожидаемые имена; `409`, если кабинет без домена, идёт другая заявка или выпуск уже запускали меньше десяти минут назад |
| `POST /certificate/auto` `{ "enabled": true }` | включить или выключить таймер продления |

В заявке нет ни домена, ни имён: служба берёт их из `zvonix.env` и `site-domain`. Каждое действие попадает в
журнал (`update.cert-*_requested`).
