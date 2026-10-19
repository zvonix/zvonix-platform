#!/usr/bin/env python3
"""Разбор новых миграций выпуска перед установкой (ADR-0086, часть 3).

    migration_scan.py <каталог миграций выпуска> <каталог миграций работающего выпуска>

Новые миграции — те, чьих файлов нет у работающего выпуска. Каждая проверяется на операторы, которые меняют или
удаляют данные (а не только добавляют): такие выпуски нельзя ставить без явного подтверждения администратора.

Код возврата: 0 — новые миграции только добавляют; 3 — есть меняющие данные (строки «файл: оператор» на стандартном
выводе); 1 — ошибка чтения. Разбор по тексту не заменяет репетицию на копии базы, а дополняет её: репетиция видит,
пройдёт ли миграция, этот разбор — что она сделает с данными, когда пройдёт.
"""
import os
import re
import sys

# Оператор → почему он опасен. Порядок не важен: выводятся все совпавшие.
RISKY = (
    (re.compile(r'\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE)\b', re.I), 'удаляет таблицу, столбец или тип'),
    (re.compile(r'\bALTER\s+COLUMN\b[^;]*\bTYPE\b', re.I), 'меняет тип столбца'),
    (re.compile(r'\bRENAME\b', re.I), 'переименовывает объект: старый код его не найдёт'),
    (re.compile(r'\bTRUNCATE\b', re.I), 'очищает таблицу'),
    (re.compile(r'\bDELETE\s+FROM\b', re.I), 'удаляет строки'),
    (re.compile(r'\bUPDATE\s+\S+\s+SET\b', re.I), 'переписывает строки'),
    (re.compile(r'\bSET\s+NOT\s+NULL\b', re.I), 'запрещает пустые значения: старый код может их писать'),
)
BREAKPOINT = '--> statement-breakpoint'


def statements(text):
    """Операторы миграции без комментариев; границы — метка drizzle и точка с запятой."""
    without_comments = re.sub(r'--(?!>)[^\n]*', '', text)
    for chunk in without_comments.split(BREAKPOINT):
        for statement in chunk.split(';'):
            statement = ' '.join(statement.split())
            if statement:
                yield statement


def scan(new_dir, current_dir):
    try:
        known = set(os.listdir(current_dir)) if os.path.isdir(current_dir) else None
        names = sorted(name for name in os.listdir(new_dir) if name.endswith('.sql'))
    except OSError as error:
        print(f'каталог миграций не читается: {error}', file=sys.stderr)
        return None, None
    # Нет работающего выпуска (первая установка): все миграции новые, но данных ещё нет — опасных нет.
    if known is None:
        return [], len(names)
    fresh = [name for name in names if name not in known]
    found = []
    for name in fresh:
        with open(os.path.join(new_dir, name), encoding='utf-8') as handle:
            text = handle.read()
        for statement in statements(text):
            for pattern, reason in RISKY:
                if pattern.search(statement):
                    found.append(f'{name}: {statement[:90]} — {reason}')
    return found, len(fresh)


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 1
    found, count = scan(sys.argv[1], sys.argv[2])
    if found is None:
        return 1
    if found:
        print('\n'.join(found))
        return 3
    print(f'новых миграций: {count}, только добавляют')
    return 0


if __name__ == '__main__':
    sys.exit(main())
