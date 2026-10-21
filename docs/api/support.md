# Контракт: обращения в поддержку

Тикеты клиентов и партнёров, переписка, статусы. Основание — [ADR-0085](../adr/0085-obrashcheniya-v-podderzhku.md).

Идентификатор автора берётся из сессии. Чужое обращение автору — `404`, как и несуществующее.

Объект обращения: `{ id, subject, category, status, cabinet, author_email, assignee_user_id, last_message_at, created_at }`.
Объект реплики: `{ id, side: "user"|"staff", body, internal, created_at }`. Ответ с перепиской — `{ ticket, messages }`.

Категории: `bug`, `feature`, `money`, `messaging`, `calls`, `other`. Статусы: `open`, `in_progress`, `waiting_user`,
`resolved`, `closed` (необратимо). Названия в кабинете зависят от того, кто смотрит ([ADR-0089](../adr/0089-obrashcheniya-statusy-i-kartinki.md)):
автору `open` — «Ждёт ответа поддержки», `waiting_user` — «Есть ответ поддержки»; сотруднику — «Новое — ждёт ответа» и «Отвечено — ждём автора».
В объекте обращения есть `unread` — поддержка ответила, автор ещё не открывал.

## Автор — клиент или партнёр (`@Cabinets('client','partner')`)

- `GET /support/tickets?status=&limit=&offset=` → `{ tickets, total }` — свои обращения, свежие сверху.
- `POST /support/tickets` `{ cabinet: "client"|"partner", subject (3–120), category, body (3–5000) }` → `201` с перепиской.
  `404` — нет кабинета указанного вида; `409` — открытых уже 20; `429` — больше 10 новых в сутки.
- `GET /support/tickets/unread` → `{ total }` — сколько обращений автора ждут прочтения (`waiting_user`, открытых автором позже ответа нет); число
  у пункта «Поддержка» в меню. Заметки сотрудников в счёт не входят.
- `GET /support/tickets/:id` → переписка **без** внутренних заметок; открытие отмечает ответ прочитанным (`author_read_at`).
- `POST /support/tickets/:id/messages` `{ body }` → `201`. Обращение уходит в «ждёт ответа» (`open`). `409` — закрыто;
  `429` — больше 60 сообщений в сутки.
- `POST /support/tickets/:id/close` → `200`; `409` — уже закрыто.

## Сотрудники (`@Roles('admin','support')`)

- `GET /support/staff/tickets?status=&cabinet=&category=&unassigned=1&q=&limit=&offset=` → очередь; `q` ищет по теме
  и адресу автора без учёта регистра.
- `GET /support/staff/tickets/:id` → переписка **с** внутренними заметками.
- `POST /support/staff/tickets/:id/messages` `{ body, internal? }` → `201`. Ответ переводит обращение в `waiting_user` и
  ставит автору письмо; заметка (`internal: true`) ни статуса, ни письма не меняет. `409` — ответ в закрытое.
- `PATCH /support/staff/tickets/:id/status` `{ status }` → журнал `support_ticket.status_changed`. `409` — закрытое не открывается.
- `PATCH /support/staff/tickets/:id/assignee` `{ assignee: "me"|null }` → журнал `support_ticket.assigned`; взятое
  `open` становится `in_progress`.

Письма: новое обращение и ответ автора — сотрудникам с подтверждённой почтой (настройка
`notifications.support_staff_enabled`, повтор не чаще раза в 15 минут по обращению); ответ сотрудника — автору.
Обращение, на которое поддержка ответила (`waiting_user`) или решённое (`resolved`), без новых реплик закрывается само через `support.autoclose_days`
суток (по умолчанию 7, `0` — не закрывать; фоновая задача `support.close-resolved`, журнал `support_ticket.auto_closed`). Ответ автора до срока
возвращает обращение в `open` и сбрасывает отсчёт.
