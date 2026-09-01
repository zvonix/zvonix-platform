#!/usr/bin/env bash
# Единая точка проверки проекта.
# Один и тот же набор шагов запускается локально и в CI — иначе «у меня проходит»
# перестаёт что-либо значить.
#
# ЗАПОЛНИТЬ после выбора стека: подставить реальные команды вместо die-заглушек.

set -euo pipefail
cd "$(dirname "$0")/.."

FAILED=()

step() {
  local name="$1"; shift
  echo ""
  echo "=== $name ==="
  if "$@"; then
    echo "--- $name: ok"
  else
    echo "--- $name: ПРОВАЛ"
    FAILED+=("$name")
  fi
}

die_not_configured() {
  echo "Шаг не настроен. Заполните scripts/check.sh после выбора стека (см. CLAUDE.md → Команды)." >&2
  return 1
}

# --- Шаги проверки -----------------------------------------------------------
# Порядок важен: сначала дешёвые и быстрые, потом дорогие.

step "Формат"     die_not_configured   # TODO: prettier --check . | ruff format --check . | gofmt -l .
step "Линтер"     die_not_configured   # TODO: eslint . | ruff check . | golangci-lint run
step "Типы"       die_not_configured   # TODO: tsc --noEmit | mypy . | (встроено в компилятор)
step "Тесты"      die_not_configured   # TODO: vitest run | pytest | go test ./...

# --- Итог --------------------------------------------------------------------
echo ""
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "Все проверки пройдены."
  exit 0
fi
echo "Провалено шагов: ${#FAILED[@]}"
printf '  - %s\n' "${FAILED[@]}"
exit 1
