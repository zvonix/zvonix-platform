# UX-правила Uxcel — путеводитель

Неизменённые копии из [Uxcel-Lab/product-skills](https://github.com/Uxcel-Lab/product-skills),
каталог `ux/`, коммит `5007cd0241ccaa51ae2e4681f9618912dc10e239` (MIT, © 2026 Uxcel Lab,
текст — [LICENSE](LICENSE)), скопированы 2026-09-22. Порядок копирования и обновления —
[../../SOURCES.md](../../SOURCES.md).

Это **правила принятия решений**, а не генераторы кода: что проверить, на что смотреть,
какой вариант выбрать при каком условии. Они написаны по-английски и для любых продуктов.

## Приоритет

1. [docs/DESIGN.md](../../../../docs/DESIGN.md) и раздел «Наши правила» в [../SKILL.md](../SKILL.md).
2. Копия правил Vercel [../web-interface-guidelines.md](../web-interface-guidelines.md).
3. Эти файлы.

Правило Uxcel, которое расходится с первыми двумя, — не находка. Правило, которое
не подходит проекту вовсе, отмечается ниже, в «Расхождениях», с датой и причиной.

**Дизайн-система у нас есть** — прототип и DESIGN.md. По собственному правилу Uxcel
(`ux-design-review`, шаг 3) тогда отключаются визуальные линзы — цвет, шрифты, сетка,
композиция — а доступность сужается до применения. Поэтому они и не скопированы:
стиль не пересматривается.

## Какой файл читать

Только тот, что под задачу. В каждом — сначала раздел «How this skill behaves», затем
«always-apply core» и таблица «context-dependent decisions».

| Задача | Файл |
|---|---|
| Таблица, список, журнал | [ux-tables.md](ux-tables.md) |
| Форма, поле, проверка ввода | [ux-inputs-and-forms.md](ux-inputs-and-forms.md) |
| Флажок, переключатель, выбор из списка | [ux-selection-controls.md](ux-selection-controls.md) |
| Кнопки, их вес и подписи | [ux-buttons.md](ux-buttons.md) |
| Меню, действия строки (⋮) | [ux-menus.md](ux-menus.md) |
| Окно подтверждения, диалог | [ux-modals-and-dialogs.md](ux-modals-and-dialogs.md) |
| Навигация, вкладки, страницы списка | [ux-navigation.md](ux-navigation.md) |
| Поиск и фильтры списка | [ux-search.md](ux-search.md) |
| Подсказки «?» | [ux-tooltips.md](ux-tooltips.md) |
| Уведомления, сообщения об успехе | [ux-notifications-and-toasts.md](ux-notifications-and-toasts.md) |
| Загрузка, скелеты | [ux-loaders-and-progress.md](ux-loaders-and-progress.md) |
| Пустой экран, «ничего не найдено» | [ux-empty-states.md](ux-empty-states.md) |
| Ошибки и восстановление после них | [ux-error-recovery.md](ux-error-recovery.md) |
| Экран настроек и сохранение | [ux-settings.md](ux-settings.md) |
| Сводный экран с цифрами | [ux-dashboard.md](ux-dashboard.md) |
| Экран входа | [ux-login-signup.md](ux-login-signup.md) |
| Тексты интерфейса — написать | [ux-microcopy.md](ux-microcopy.md) |
| Аудит: удобство (эвристики Нильсена) | [ux-heuristics-audit.md](ux-heuristics-audit.md) |
| Аудит: тексты интерфейса | [ux-microcopy-audit.md](ux-microcopy-audit.md) |
| Аудит: телефон и адаптивность | [ux-mobile-responsiveness-audit.md](ux-mobile-responsiveness-audit.md) |
| Аудит: структура разделов и названия | [ux-information-architecture-audit.md](ux-information-architecture-audit.md) |
| Аудит: уловки против пользователя (деньги, отказы) | [ux-dark-patterns-audit.md](ux-dark-patterns-audit.md) |
| Полное ревью экрана — порядок линз | [ux-design-review.md](ux-design-review.md) |

## Ссылки внутри файлов

Файлы ссылаются друг на друга по имени навыка: `ux-tables` — это `ux-tables.md` здесь.
Упоминание `docs/orchestration-policy.md` — файл их репозитория, не нашего.

Не скопированы, и ссылки на них пропускаются:
- `ux-accessibility-audit` → вместо него навыки [accessibility](../../accessibility/SKILL.md)
  и [a11y-debugging](../../a11y-debugging/SKILL.md);
- `ux-aesthetics-audit`, `ux-color`, `ux-typography`, `ux-layout-spacing-grids`,
  `ux-iconography` — отключены дизайн-системой (выше);
- `ux-cards`, `ux-onboarding`, `ux-offboarding`, `ux-checkout-payment`, `ux-pricing`,
  `ux-landing-page`, `ux-contact-support`, `ux-activity-feed` — таких экранов у нас нет.

## Расхождения с проектом

Что в этих файлах звучит как правило, а у нас решено иначе. Проверка по такому пункту
ищет наше правило, а не их.

- **Плотность строк.** Uxcel по умолчанию — 48 px. У нас плотность по аудитории
  (DESIGN.md, «Три аудитории»): админке — максимальная, клиенту — понятность, партнёру —
  телефон и первый экран без прокрутки.
- **Размер цели.** Uxcel — 44–48 px везде. Обязательный минимум у нас — 24×24 (WCAG 2.2 AA);
  44 и больше — в кабинете партнёра на телефоне.
- **Отмена вместо подтверждения.** Uxcel советует «Undo» для обратимых действий. У нас
  действие над деньгами, трафиком и защитой идёт через `ConfirmAction` с последствием
  в тексте, а возврат в работу — одним нажатием; механизма отмены нет.
- **Проверка поля «при уходе фокуса».** У нас негодный ввод называется причиной рядом
  с полем и блокирует отправку (раздел «Деньги» в [../SKILL.md](../SKILL.md)); момент
  проверки — как в существующих формах, а не как здесь.
- **Регистрация, вход через соцсети, «запомнить меня», восстановление пароля**
  из `ux-login-signup` — к нам не относятся: учётные записи заводит администратор,
  сессия — по [ADR-0018](../../../../docs/adr/0018-autentifikaciya.md) и
  [ADR-0037](../../../../docs/adr/0037-sessiya-v-brauzere.md).
- **Тексты.** Примеры английские. Русский интерфейс: «ёлочки», многоточие одним знаком,
  термины — из [GLOSSARY.md](../../../../docs/GLOSSARY.md) (канал ≠ порт шлюза).
- **Сводные экраны.** «Дашбордов ради дашбордов» у нас нет вовсе (DESIGN.md, «Чего
  не делаем») — `ux-dashboard` применяется к экранам, где с цифры начинается действие.

## Обновление

Сравнить закреплённый коммит с новым по каталогу `ux/` (команда — в
[../../SOURCES.md](../../SOURCES.md)), перенести изменения в одноимённые файлы, обновить
коммит и дату здесь и в `SOURCES.md`.
