#!/usr/bin/env python3
"""Служба обновления площадки из кабинета (ADR-0074). Запускается от root службой zvonix-updater.

Читает заявки, которые кладёт API (пользователь zvonix), и сама вызывает zvonix-deploy. Заявке не
доверяет: файл читается без перехода по ссылкам и не больше MAX_REQUEST байт, действие — из списка,
метка — по шаблону выкладки, идентификатор — UUID. Значения не попадают в оболочку: только список
аргументов.

Каталог обмена (ZVONIX_UPDATER_DIR):
  requests/<id>.json   заявка от API; пишет zvonix
  runs/<id>/state.json состояние заявки; пишет только root
  runs/<id>/log        вывод выкладки построчно
  releases.json        список выпусков из GitHub (токен — только у root)
"""
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone

ROOT = os.environ.get('ZVONIX_UPDATER_DIR', '/var/lib/zvonix-updater')
# Команда выкладки; в проверках подменяется (может быть несколькими словами).
DEPLOY = shlex.split(os.environ.get('ZVONIX_DEPLOY_CMD', '/usr/local/sbin/zvonix-deploy'))
GITHUB_ENV = os.environ.get('ZVONIX_GITHUB_ENV', '/etc/zvonix/github.env')
REFRESH_EVERY = int(os.environ.get('ZVONIX_REFRESH_SECONDS', '600'))
MAX_REQUEST = 4096
KEEP_RUNS = 30
TAG_PATTERN = re.compile(r'^v?[0-9A-Za-z][0-9A-Za-z._-]*$')
ID_PATTERN = re.compile(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json')
ACTIONS = ('deploy', 'rollback', 'refresh')

requests_dir = os.path.join(ROOT, 'requests')
runs_dir = os.path.join(ROOT, 'runs')
releases_file = os.path.join(ROOT, 'releases.json')


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def write_atomic(path, text):
    """Файл меняется подменой: API читает его в любой момент и не должен увидеть половину."""
    temp = path + '.tmp'
    with open(temp, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.chmod(temp, 0o644)
    os.replace(temp, path)


def read_request(path):
    """Заявка или None. Ссылки и не-файлы отвергаются, размер ограничен."""
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REQUEST:
            return None
        raw = os.read(descriptor, MAX_REQUEST + 1)
    finally:
        os.close(descriptor)
    try:
        request = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(request, dict):
        return None
    action = request.get('action')
    tag = request.get('tag')
    if action not in ACTIONS:
        return None
    if action == 'deploy' and not (isinstance(tag, str) and TAG_PATTERN.match(tag)):
        return None
    return {'action': action, 'tag': tag if action == 'deploy' else None,
            'by': str(request.get('by', ''))[:200], 'at': str(request.get('at', ''))[:40]}


def write_state(run, **fields):
    run.update(fields)
    write_atomic(os.path.join(runs_dir, run['id'], 'state.json'), json.dumps(run, ensure_ascii=False))


def pending():
    """Заявки к исполнению по порядку поступления; негодные удаляются."""
    found = []
    try:
        names = os.listdir(requests_dir)
    except OSError:
        return found
    for name in names:
        match = ID_PATTERN.fullmatch(name)
        if match is None:
            continue
        path = os.path.join(requests_dir, name)
        request = read_request(path)
        if request is None:
            print(f'заявка {name} негодна — удалена', file=sys.stderr)
            try:
                os.unlink(path)
            except OSError:
                pass
            continue
        try:
            found.append((os.lstat(path).st_mtime, match.group(1), path, request))
        except OSError:
            continue
    found.sort()
    return found


def run_request(request_id, path, request):
    run_dir = os.path.join(runs_dir, request_id)
    os.makedirs(run_dir, mode=0o755, exist_ok=True)
    os.chmod(run_dir, 0o755)
    run = {'id': request_id, 'action': request['action'], 'tag': request['tag'], 'by': request['by'],
           'requested_at': request['at'], 'status': 'running', 'started_at': now(),
           'finished_at': None, 'exit_code': None}
    write_state(run)
    # Заявка принята: после этого API её уже не отменит. Удаление — после записи состояния,
    # чтобы заявка не пропала из вида между двумя файлами.
    try:
        os.unlink(path)
    except OSError:
        pass

    log_path = os.path.join(run_dir, 'log')
    if request['action'] == 'refresh':
        refresh_releases(log_path, run)
        return

    command = DEPLOY + ([request['tag']] if request['action'] == 'deploy' else ['--rollback'])
    with open(log_path, 'wb', buffering=0) as log:
        os.chmod(log_path, 0o644)
        log.write(('$ zvonix-deploy ' + ' '.join(command[1:]) + '\n').encode())
        try:
            code = subprocess.call(command, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        except OSError as error:
            log.write(f'не удалось запустить выкладку: {error}\n'.encode())
            code = 127
    write_state(run, status='succeeded' if code == 0 else 'failed', finished_at=now(), exit_code=code)


def read_env(path):
    env = {}
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if '=' in line and not line.startswith('#'):
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def refresh_releases(log_path, run=None):
    """Список выпусков из GitHub по токену выкладки. Сбой — в журнал, старый список остаётся."""
    try:
        env = read_env(GITHUB_ENV)
        repository, token = env.get('GITHUB_REPOSITORY', ''), env.get('GITHUB_TOKEN', '')
        if not repository or not token:
            raise RuntimeError('в github.env не заданы GITHUB_REPOSITORY и GITHUB_TOKEN')
        http = urllib.request.Request(
            f'https://api.github.com/repos/{repository}/releases?per_page=30',
            headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(http, timeout=30) as response:
            items = json.load(response)
        releases = []
        for item in items:
            tag = item.get('tag_name')
            if not isinstance(tag, str) or not TAG_PATTERN.match(tag) or item.get('draft'):
                continue
            releases.append({'tag': tag, 'name': str(item.get('name') or tag)[:200],
                             'published_at': item.get('published_at'),
                             'prerelease': bool(item.get('prerelease')),
                             'notes': str(item.get('body') or '')[:2000]})
        write_atomic(releases_file, json.dumps({'fetched_at': now(), 'releases': releases}, ensure_ascii=False))
        ok, message = True, 'выпусков: ' + str(len(releases))
    except Exception as error:  # noqa: BLE001 — сбой сети или разбора: список не обновлён, служба живёт
        ok, message = False, 'список выпусков не обновлён: ' + str(error)
    if log_path is not None:
        with open(log_path, 'w', encoding='utf-8') as handle:
            handle.write(message + '\n')
        os.chmod(log_path, 0o644)
    if run is not None:
        write_state(run, status='succeeded' if ok else 'failed', finished_at=now(), exit_code=0 if ok else 1)
    else:
        print(message)


def prune_runs():
    try:
        names = sorted(os.listdir(runs_dir), key=lambda n: os.lstat(os.path.join(runs_dir, n)).st_mtime)
    except OSError:
        return
    for name in names[:-KEEP_RUNS]:
        directory = os.path.join(runs_dir, name)
        for entry in os.listdir(directory):
            os.unlink(os.path.join(directory, entry))
        os.rmdir(directory)


def releases_stale():
    try:
        return time.time() - os.stat(releases_file).st_mtime > REFRESH_EVERY
    except OSError:
        return True


def main():
    os.makedirs(requests_dir, exist_ok=True)
    os.makedirs(runs_dir, mode=0o755, exist_ok=True)
    # Заявки — по одной, пока очередь не пуста: новая могла прийти, пока шла выкладка.
    done = set()
    while True:
        queue = [item for item in pending() if item[1] not in done]
        if not queue:
            break
        _, request_id, path, request = queue[0]
        done.add(request_id)
        run_request(request_id, path, request)
    if releases_stale():
        refresh_releases(None)
    prune_runs()


if __name__ == '__main__':
    main()
