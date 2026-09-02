#!/usr/bin/env bash
# Единая точка проверки проекта.
# Один и тот же набор шагов запускается локально и в CI — иначе «у меня проходит»
# перестаёт что-либо значить.
#
# Порядок шагов: сначала дешёвые и быстрые, потом дорогие. Шаг, упавший рано,
# не заставляет ждать пять минут ради того же ответа.
#
# У шага три исхода, а не два:
#   ok            — выполнен и прошёл;
#   ПРОВАЛ        — выполнен и не прошёл, код возврата 1;
#   НЕ ВЫПОЛНЕН   — не смог запуститься (нет сети, нет базы). Не считается успехом
#                   и печатается отдельным списком: «проверка не запускалась»
#                   и «ошибок нет» — разные утверждения.
#
# Интеграционным тестам и смоуку нужна живая PostgreSQL (ADR-0006). Адрес —
# TEST_DATABASE_URL, по умолчанию локальная база zvonix_test.
# Фоновому процессу нужна ещё и Redis (ADR-0020): TEST_REDIS_URL, по умолчанию
# база 15 на локальном сервере. Номер базы не нулевой намеренно: проверки её очищают.

# Без `set -e` намеренно: скрипт обязан выполнить все шаги и показать полную картину,
# а не остановиться на первом упавшем. Исход каждого шага обрабатывается явно.
set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=()
SKIPPED=()
TIMINGS=()

# Выполняет шаг и запоминает исход и время.
step() {
  local name="$1"; shift
  local started ended
  echo ""
  echo "=== $name ==="
  started=$(date +%s)
  if "$@"; then
    ended=$(date +%s)
    TIMINGS+=("$name|$((ended - started))|ok")
    echo "--- $name: ok"
  else
    ended=$(date +%s)
    TIMINGS+=("$name|$((ended - started))|ПРОВАЛ")
    echo "--- $name: ПРОВАЛ"
    FAILED+=("$name")
  fi
}

# Шаг, который может оказаться невыполнимым по внешней причине.
# Код возврата 78 означает «не выполнен», а не «провален».
step_optional() {
  local name="$1"; shift
  local started ended code
  echo ""
  echo "=== $name ==="
  started=$(date +%s)
  "$@"
  code=$?
  ended=$(date +%s)
  if [ $code -eq 0 ]; then
    TIMINGS+=("$name|$((ended - started))|ok")
    echo "--- $name: ok"
  elif [ $code -eq 78 ]; then
    TIMINGS+=("$name|$((ended - started))|НЕ ВЫПОЛНЕН")
    echo "--- $name: НЕ ВЫПОЛНЕН"
    SKIPPED+=("$name")
  else
    TIMINGS+=("$name|$((ended - started))|ПРОВАЛ")
    echo "--- $name: ПРОВАЛ"
    FAILED+=("$name")
  fi
}

# --- Отдельные проверки, которым нужна логика, а не одна команда ---------------

# Схема Drizzle не должна расходиться с миграциями. Если кто-то правил схему
# и не сгенерировал миграцию, база разойдётся с кодом (ADR-0005). Генерация
# не должна давать новых или изменённых файлов.
migrations_match_schema() {
  local before after
  before=$(git status --porcelain packages/db/migrations)
  pnpm db:generate >/dev/null 2>&1 || { echo "Не удалось выполнить db:generate"; return 1; }
  after=$(git status --porcelain packages/db/migrations)
  if [ "$before" != "$after" ]; then
    echo "Схема изменена без миграции. Выполните pnpm db:generate и закоммитьте результат:"
    git status --porcelain packages/db/migrations
    return 1
  fi
  echo "Миграции соответствуют схеме."
}

# Уязвимости в зависимостях. Требует доступа к реестру пакетов: без сети шаг
# не выполняется, но и успехом не считается.
dependency_audit() {
  local output code
  output=$(pnpm audit --audit-level moderate 2>&1)
  code=$?
  if [ $code -eq 0 ]; then
    echo "Известных уязвимостей уровня moderate и выше нет."
    return 0
  fi
  # Признаки того, что реестр недоступен. `fetch failed` — то, что печатает pnpm,
  # когда соединение не установилось; остальное приходит от резолвера имён и сокета.
  if echo "$output" | grep -qiE 'fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|socket hang up'; then
    echo "Нет доступа к реестру пакетов — аудит не выполнен."
    return 78
  fi
  echo "$output"
  return 1
}

# --- Шаги проверки -----------------------------------------------------------

step "Формат"        pnpm format:check
step "Ссылки в доках" node scripts/docs-links.mjs
step "Конфиг узла"    node scripts/node-config.mjs
step "Линтер"        pnpm lint
step "Типы"          pnpm typecheck
step "Мёртвый код"   pnpm deadcode
step "Миграции"      migrations_match_schema
step "Тесты"         pnpm test
step "Тесты с БД"    pnpm test:integration
step "Смоук запуска" node scripts/smoke.mjs
step "Смоук воркера"  node scripts/smoke-worker.mjs
step_optional "Аудит зависимостей" dependency_audit

# --- Итог --------------------------------------------------------------------

echo ""
echo "=== Итог ==="
# Выравнивание по исходу, а не по имени шага: ширина кириллицы в printf зависит
# от локали и на Git Bash считается в байтах. Набор исходов известен заранее.
for row in "${TIMINGS[@]}"; do
  IFS='|' read -r name seconds outcome <<< "$row"
  case "$outcome" in
    ok)            marker='ok         ' ;;
    'ПРОВАЛ')      marker='ПРОВАЛ     ' ;;
    'НЕ ВЫПОЛНЕН') marker='НЕ ВЫПОЛНЕН' ;;
    *)             marker="$outcome"    ;;
  esac
  printf '  %s  %4s c   %s\n' "$marker" "$seconds" "$name"
done

echo ""
if [ ${#SKIPPED[@]} -gt 0 ]; then
  echo "Не выполнено (не успех): ${#SKIPPED[@]}"
  printf '  - %s\n' "${SKIPPED[@]}"
  echo ""
fi

if [ ${#FAILED[@]} -eq 0 ]; then
  if [ ${#SKIPPED[@]} -eq 0 ]; then
    echo "Все проверки пройдены."
  else
    echo "Все выполненные проверки пройдены, но выполнены не все — см. список выше."
  fi
  exit 0
fi

echo "Провалено шагов: ${#FAILED[@]}"
printf '  - %s\n' "${FAILED[@]}"
exit 1
