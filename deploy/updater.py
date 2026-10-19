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
  certificate.json     состояние сертификата кабинета (ADR-0083): даты, имена, автопродление
  backups.json         резервные копии, итог их проверки и последнее скачивание (ADR-0086)
  exports/<id>.dump    копия, выданная для скачивания; API отдаёт и удаляет, служба убирает за полчаса
"""
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.environ.get('ZVONIX_UPDATER_DIR', '/var/lib/zvonix-updater')
# Команда выкладки; в проверках подменяется (может быть несколькими словами).
DEPLOY = shlex.split(os.environ.get('ZVONIX_DEPLOY_CMD', '/usr/local/sbin/zvonix-deploy'))
GITHUB_ENV = os.environ.get('ZVONIX_GITHUB_ENV', '/etc/zvonix/github.env')
# Адрес API GitHub; подменяется только в проверках.
GITHUB_API = os.environ.get('ZVONIX_GITHUB_API', 'https://api.github.com').rstrip('/')
# Токен GitHub (ADR-0084): классические и fine-grained токены — буквы, цифры и подчёркивание.
TOKEN_PATTERN = re.compile(r'^[A-Za-z0-9_]{20,255}$')
REFRESH_EVERY = int(os.environ.get('ZVONIX_REFRESH_SECONDS', '600'))
MAX_REQUEST = 4096
KEEP_RUNS = 30
TAG_PATTERN = re.compile(r'^v?[0-9A-Za-z][0-9A-Za-z._-]*$')
ID_PATTERN = re.compile(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json')
ACTIONS = ('deploy', 'prepare', 'rollback', 'refresh', 'cert-check', 'cert-issue', 'cert-auto-on', 'cert-auto-off',
           'token-set', 'backup-create', 'backup-verify', 'backup-export')

# Сертификат кабинета (ADR-0083). Имена берутся из файлов root, а не из заявки: заявка не называет
# домен, поэтому выпустить сертификат на чужое имя через неё нельзя.
ENV_FILE = os.environ.get('ZVONIX_ENV_FILE', '/etc/zvonix/zvonix.env')
SITE_DOMAIN_FILE = os.environ.get('ZVONIX_SITE_DOMAIN_FILE', '/etc/zvonix/site-domain')
LETSENCRYPT_DIR = os.environ.get('ZVONIX_LETSENCRYPT_DIR', '/etc/letsencrypt')
ACME_ROOT = os.environ.get('ZVONIX_ACME_ROOT', '/var/www/letsencrypt')
CERTBOT = shlex.split(os.environ.get('ZVONIX_CERTBOT_CMD', 'certbot'))
OPENSSL = shlex.split(os.environ.get('ZVONIX_OPENSSL_CMD', 'openssl'))
SYSTEMCTL = shlex.split(os.environ.get('ZVONIX_SYSTEMCTL_CMD', 'systemctl'))
HOST_PATTERN = re.compile(r'^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')
CERT_TIMER = 'certbot.timer'

requests_dir = os.path.join(ROOT, 'requests')
runs_dir = os.path.join(ROOT, 'runs')
releases_file = os.path.join(ROOT, 'releases.json')
certificate_file = os.path.join(ROOT, 'certificate.json')
github_token_file = os.path.join(ROOT, 'github-token.json')


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
    if action in ('deploy', 'prepare') and not (isinstance(tag, str) and TAG_PATTERN.match(tag)):
        return None
    token = None
    if action == 'token-set':
        token = request.get('token')
        if not (isinstance(token, str) and TOKEN_PATTERN.match(token)):
            return None
    target = None
    if action in ('backup-verify', 'backup-export'):
        target = request.get('target')
        if not (isinstance(target, str) and BACKUP_ID.match(target)):
            return None
    return {'action': action, 'tag': tag if action in ('deploy', 'prepare') else None,
            'by': str(request.get('by', ''))[:200], 'at': str(request.get('at', ''))[:40],
            'token': token, 'target': target}


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
           'target': request['target'], 'requested_at': request['at'], 'status': 'running', 'started_at': now(),
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
    if request['action'].startswith('cert-'):
        run_certificate(request['action'], log_path, run)
        return
    if request['action'] == 'token-set':
        run_token_set(request['token'], log_path, run)
        return
    if request['action'].startswith('backup-'):
        run_backup(request, request_id, log_path, run)
        return

    arguments = {'deploy': [request['tag']], 'prepare': ['--prepare', request['tag']], 'rollback': ['--rollback']}
    command = DEPLOY + arguments[request['action']]
    with open(log_path, 'wb', buffering=0) as log:
        os.chmod(log_path, 0o644)
        log.write(('$ zvonix-deploy ' + ' '.join(command[len(DEPLOY):]) + '\n').encode())
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
    repository = ''
    try:
        env = read_env(GITHUB_ENV)
        repository, token = env.get('GITHUB_REPOSITORY', ''), env.get('GITHUB_TOKEN', '')
        if not repository or not token:
            raise RuntimeError('в github.env не заданы GITHUB_REPOSITORY и GITHUB_TOKEN')
        http = urllib.request.Request(
            f'{GITHUB_API}/repos/{repository}/releases?per_page=30',
            headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(http, timeout=30) as response:
            items = json.load(response)
            write_token_status(repository, True, response.headers.get('github-authentication-token-expiration'), None)
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
    except urllib.error.HTTPError as error:
        # Отказ GitHub по токену — это состояние токена, а не сети: кабинет покажет его и письмом предупредит.
        if error.code in (401, 403, 404):
            write_token_status(repository, False, None, token_problem(error.code))
        ok, message = False, 'список выпусков не обновлён: ' + str(error)
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


def token_problem(code):
    """Что сказать администратору об отказе GitHub: по-русски, без токена и без ответа GitHub."""
    if code == 401:
        return 'GitHub не принял токен: он отозван или истёк'
    return ('у токена нет доступа к репозиторию: проверьте, что он выпущен на организацию-владельца '
            'и ему дано право «Contents: Read-only»')


def parse_token_expiry(value):
    """Срок токена из заголовка GitHub («2026-12-31 12:00:00 UTC») в ISO; нет заголовка — None."""
    if not value:
        return None
    text = value.strip().replace(' UTC', '+00:00').replace(' ', 'T', 1)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec='seconds')


def write_token_status(repository, valid, expires_header, problem):
    """Состояние токена для кабинета. Сам токен сюда не попадает никогда."""
    write_atomic(github_token_file, json.dumps({
        'checked_at': now(), 'repository': repository, 'valid': valid,
        'expires_at': parse_token_expiry(expires_header), 'problem': problem,
    }, ensure_ascii=False))


def write_env_token(token):
    """Строка GITHUB_TOKEN в github.env заменяется подменой файла; остальные строки и права сохраняются."""
    lines = []
    replaced = False
    with open(GITHUB_ENV, encoding='utf-8') as handle:
        for line in handle.read().splitlines():
            if line.strip().startswith('GITHUB_TOKEN='):
                lines.append('GITHUB_TOKEN=' + token)
                replaced = True
            else:
                lines.append(line)
    if not replaced:
        lines.append('GITHUB_TOKEN=' + token)
    temp = GITHUB_ENV + '.tmp'
    descriptor = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    os.chmod(temp, 0o600)
    os.replace(temp, GITHUB_ENV)


def run_token_set(token, log_path, run):
    """Новый токен GitHub: проверяется у GitHub и только потом записывается. Репозиторий — из github.env, не из заявки."""
    lines = []
    code = 0
    repository = ''
    try:
        repository = read_env(GITHUB_ENV).get('GITHUB_REPOSITORY', '')
        if not repository:
            raise RuntimeError('в github.env не задан GITHUB_REPOSITORY')
        http = urllib.request.Request(
            f'{GITHUB_API}/repos/{repository}/releases?per_page=1',
            headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'})
        with urllib.request.urlopen(http, timeout=30) as response:
            expires = response.headers.get('github-authentication-token-expiration')
            response.read()
        write_env_token(token)
        write_token_status(repository, True, expires, None)
        until = parse_token_expiry(expires)
        lines.append('токен принят и записан' + (f'; действует до {until}' if until else '; срок не ограничен'))
    except urllib.error.HTTPError as error:
        problem = token_problem(error.code) if error.code in (401, 403, 404) else f'GitHub ответил {error.code}'
        lines.append('токен не записан: ' + problem)
        code = 1
    except Exception as error:  # noqa: BLE001 — сеть или файлы: прежний токен остаётся
        lines.append('токен не записан: ' + str(error).replace(token, '***'))
        code = 1
    with open(log_path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    os.chmod(log_path, 0o644)
    write_state(run, status='succeeded' if code == 0 else 'failed', finished_at=now(), exit_code=code)



def cert_names():
    """(имя сертификата, все имена) из файлов root; (None, []) — кабинет не на домене (туннель)."""
    try:
        url = read_env(ENV_FILE).get('WEB_BASE_URL', '').strip().lower().rstrip('/')
    except OSError:
        return None, []
    match = re.fullmatch(r'https://([a-z0-9.-]+)', url)
    if match is None or not HOST_PATTERN.match(match.group(1)) or '.' not in match.group(1):
        return None, []
    name = match.group(1)
    names = [name]
    try:
        with open(SITE_DOMAIN_FILE, encoding='utf-8') as handle:
            domain = handle.readline().strip().lower()
    except OSError:
        domain = ''
    # Основной домен действует, пока кабинет на cp.<домен> (как в deploy/server-setup.sh).
    if domain and HOST_PATTERN.match(domain) and name == 'cp.' + domain:
        names += [domain, 'www.' + domain]
    return name, names


def run_quiet(command):
    """(код, вывод) команды; не найденная команда — (127, текст). Без оболочки, с ограничением по времени."""
    try:
        done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                              timeout=60, env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, str(error)
    return done.returncode, done.stdout.decode('utf-8', 'replace')


def parse_openssl_date(value):
    try:
        moment = datetime.strptime(value.strip(), '%b %d %H:%M:%S %Y %Z')
    except ValueError:
        return None
    return moment.replace(tzinfo=timezone.utc).isoformat(timespec='seconds')


def cert_status():
    """Читает сертификат и таймер продления и пишет certificate.json. Сбой чтения — в поле, а не исключением."""
    name, names = cert_names()
    status = {'checked_at': now(), 'cert_name': name, 'expected_names': names, 'present': False,
              'not_before': None, 'not_after': None, 'issuer': None, 'covered_names': [],
              'auto_renew': None, 'auto_renew_active': None, 'problem': None}
    if name is None:
        status['problem'] = 'адрес кабинета не домен: сертификат не выпускается'
    else:
        path = os.path.join(LETSENCRYPT_DIR, 'live', name, 'fullchain.pem')
        if os.path.exists(path):
            code, output = run_quiet(OPENSSL + ['x509', '-in', path, '-noout', '-dates', '-issuer', '-ext', 'subjectAltName'])
            if code == 0:
                status['present'] = True
                for line in output.splitlines():
                    line = line.strip()
                    if line.startswith('notBefore='):
                        status['not_before'] = parse_openssl_date(line[len('notBefore='):])
                    elif line.startswith('notAfter='):
                        status['not_after'] = parse_openssl_date(line[len('notAfter='):])
                    elif line.startswith('issuer='):
                        match = re.search(r'O\s*=\s*([^,]+)', line)
                        status['issuer'] = (match.group(1) if match else line[len('issuer='):]).strip()[:100]
                    elif 'DNS:' in line:
                        status['covered_names'] = [part.strip()[4:].lower() for part in line.split(',')
                                                   if part.strip().startswith('DNS:')]
            else:
                status['problem'] = 'не удалось прочитать сертификат: ' + output.strip()[:200]
    code, output = run_quiet(SYSTEMCTL + ['is-enabled', CERT_TIMER])
    status['auto_renew'] = output.strip() == 'enabled' if code in (0, 1) else None
    code, output = run_quiet(SYSTEMCTL + ['is-active', CERT_TIMER])
    status['auto_renew_active'] = output.strip() == 'active' if code in (0, 3) else None
    write_atomic(certificate_file, json.dumps(status, ensure_ascii=False))
    return status


def run_certificate(action, log_path, run):
    """Действие над сертификатом: проверить, выпустить, включить или выключить автопродление."""
    lines = []
    code = 0
    name, names = cert_names()
    if action == 'cert-check':
        lines.append('сертификат проверен')
    elif action == 'cert-issue':
        if name is None:
            lines.append('адрес кабинета не домен — выпускать сертификат не на что')
            code = 1
        else:
            command = CERTBOT + ['certonly', '--webroot', '-w', ACME_ROOT, '--cert-name', name]
            for host in names:
                command += ['-d', host]
            command += ['--expand', '--force-renewal', '--non-interactive', '--agree-tos',
                        '--register-unsafely-without-email', '--deploy-hook', 'systemctl reload nginx']
            lines.append('$ certbot certonly ... ' + ' '.join('-d ' + host for host in names))
            code, output = run_quiet(command)
            lines.append(output.strip()[-3000:])
    elif action in ('cert-auto-on', 'cert-auto-off'):
        verb = ['enable', '--now'] if action == 'cert-auto-on' else ['disable', '--now']
        lines.append('$ systemctl ' + ' '.join(verb) + ' ' + CERT_TIMER)
        code, output = run_quiet(SYSTEMCTL + verb + [CERT_TIMER])
        lines.append(output.strip()[-1000:])
    with open(log_path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(line for line in lines if line) + '\n')
    os.chmod(log_path, 0o644)
    # Состояние пишется после действия: кабинет сразу видит новые даты и таймер.
    cert_status()
    write_state(run, status='succeeded' if code == 0 else 'failed', finished_at=now(), exit_code=code)


# --- Резервные копии (ADR-0086) -------------------------------------------------------------------------------
# Каталоги копий закрыты для всех, кроме postgres и root; API копии не читает, а просит службу. Идентификатор
# копии — «вид/имя файла»; он проверяется по шаблону и по настоящему файлу в каталоге, а не склеивается в путь.
BACKUP_ROOT = os.environ.get('ZVONIX_BACKUPS_DIR', '/var/backups/zvonix')
BACKUP_ID = re.compile(r'^(daily|manual|update|before-restore)/([A-Za-z0-9][A-Za-z0-9._-]{0,120}\.dump)$')
BACKUP_CMD = shlex.split(os.environ.get('ZVONIX_BACKUP_CMD', '/usr/local/sbin/zvonix-backup'))
# Команды PostgreSQL выполняются от его владельца; в проверках префикс пустой, а команды подставные.
PG_PREFIX = shlex.split(os.environ.get('ZVONIX_PG_PREFIX', 'sudo -u postgres'))
PG_BIN_DIR = os.environ.get('ZVONIX_PG_BIN_DIR', '')
VERIFY_DB = 'zvonix_verify'
# Копия для скачивания кладётся в exports/ владельцем кабинета: API отдаёт файл и сам его удаляет.
EXPORT_OWNER = os.environ.get('ZVONIX_EXPORT_OWNER', 'zvonix')
EXPORT_TTL = 1800
# Меньше стольких таблиц в «настоящей» копии быть не может: пустое оглавление — повреждённый файл.
MIN_TABLES = 10
backups_file = os.path.join(ROOT, 'backups.json')
backup_checks_file = os.path.join(ROOT, 'backup-checks.json')
last_export_file = os.path.join(ROOT, 'last-export.json')
exports_dir = os.path.join(ROOT, 'exports')


def backup_dir(kind):
    return BACKUP_ROOT if kind == 'update' else os.path.join(BACKUP_ROOT, kind)


def backup_path(backup_id):
    """Путь копии по идентификатору или None: шаблон, настоящий файл, не ссылка."""
    match = BACKUP_ID.match(backup_id or '')
    if match is None:
        return None
    path = os.path.join(backup_dir(match.group(1)), match.group(2))
    if os.path.islink(path) or not os.path.isfile(path):
        return None
    return path


def list_backups():
    """Копии по всем каталогам, свежие первыми: [{id, kind, name, size, created_at}]."""
    items = []
    for kind in ('daily', 'manual', 'update', 'before-restore'):
        try:
            names = os.listdir(backup_dir(kind))
        except OSError:
            continue
        for name in names:
            backup_id = kind + '/' + name
            path = backup_path(backup_id)
            if path is None:
                continue
            info = os.stat(path)
            items.append({'id': backup_id, 'kind': kind, 'name': name, 'size': info.st_size,
                          'created_at': datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(timespec='seconds')})
    items.sort(key=lambda item: item['created_at'], reverse=True)
    return items


def read_json_file(path):
    try:
        with open(path, encoding='utf-8') as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_backups():
    """backups.json для кабинета: копии, итог последней проверки каждой и последнее скачивание."""
    checks = (read_json_file(backup_checks_file) or {}).get('checks', {})
    items = list_backups()
    for item in items:
        check = checks.get(item['id'])
        item['check'] = check if isinstance(check, dict) else None
    write_atomic(backups_file, json.dumps({'generated_at': now(), 'items': items,
                                           'last_export': read_json_file(last_export_file)}, ensure_ascii=False))


def pg(name, *arguments):
    """Команда PostgreSQL от его владельца; имя — из фиксированного набора, значения — только аргументами."""
    program = os.path.join(PG_BIN_DIR, name) if PG_BIN_DIR else name
    return PG_PREFIX + [program] + list(arguments)


def run_long(command, timeout=3600):
    """(код, вывод) долгой команды; нет команды или вышло время — (127, текст)."""
    try:
        done = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                              timeout=timeout, env={**os.environ, 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired) as error:
        return 127, str(error)
    return done.returncode, done.stdout.decode('utf-8', 'replace')


def remember_check(backup_id, ok, detail):
    checks = (read_json_file(backup_checks_file) or {}).get('checks', {})
    checks[backup_id] = {'at': now(), 'ok': ok, 'detail': detail[:300]}
    # Только существующие копии: запись о давно удалённой не должна копиться.
    existing = {item['id'] for item in list_backups()}
    write_atomic(backup_checks_file, json.dumps({'checks': {key: value for key, value in checks.items()
                                                            if key in existing}}, ensure_ascii=False))


def verify_backup(backup_id, lines):
    """Копия разворачивается во временную базу и проверяется. Рабочая база не затрагивается. Возвращает код."""
    path = backup_path(backup_id)
    if path is None:
        lines.append('копия не найдена')
        return 1
    ok, detail = False, ''
    try:
        code, output = run_long(pg('pg_restore', '--list', path), 600)
        entries = [line for line in output.splitlines() if line.strip() and not line.startswith(';')]
        if code != 0 or sum(1 for line in entries if re.search(r'\sTABLE\s+public\s', line)) < MIN_TABLES:
            detail = 'оглавление копии не читается или в ней нет таблиц'
            return 1
        lines.append('оглавление читается')
        run_long(pg('dropdb', '--if-exists', VERIFY_DB), 300)
        code, output = run_long(pg('createdb', VERIFY_DB), 300)
        if code != 0:
            detail = 'временная база не создана: ' + output.strip()[-200:]
            return 1
        code, output = run_long(pg('pg_restore', '--no-owner', '--exit-on-error', '-d', VERIFY_DB, path))
        if code != 0:
            detail = 'копия не разворачивается: ' + output.strip()[-200:]
            return 1
        lines.append('копия развёрнута во временной базе')
        code, output = run_long(pg('psql', '-d', VERIFY_DB, '-At', '-c',
                                   "select count(*) from information_schema.tables where table_schema = 'public'"), 300)
        tables = output.strip().splitlines()[-1] if code == 0 and output.strip() else '?'
        counts = []
        for table, name in (('users', 'пользователей'), ('clients', 'клиентов'), ('partners', 'партнёров'),
                            ('payments', 'платежей')):
            code, output = run_long(pg('psql', '-d', VERIFY_DB, '-At', '-c', 'select count(*) from ' + table), 300)
            if code == 0 and output.strip():
                counts.append(name + ' ' + output.strip().splitlines()[-1])
        detail = 'таблиц ' + tables + (', ' + ', '.join(counts) if counts else '')
        ok = True
        return 0
    finally:
        # Временная база убирается всегда; рабочая от неё не зависит.
        run_long(pg('dropdb', '--if-exists', VERIFY_DB), 300)
        lines.append(('копия годна: ' if ok else 'копия не годна: ') + detail)
        remember_check(backup_id, ok, detail)


def export_backup(backup_id, request_id, by, lines):
    """Копия для скачивания: файл в exports/ владельцем кабинета; API отдаёт его один раз и удаляет."""
    path = backup_path(backup_id)
    if path is None:
        lines.append('копия не найдена')
        return 1
    os.makedirs(exports_dir, exist_ok=True)
    # Каталог выдачи принадлежит владельцу кабинета: он сам удаляет скачанный файл.
    if EXPORT_OWNER:
        shutil.chown(exports_dir, user=EXPORT_OWNER)
    os.chmod(exports_dir, 0o750)
    try:
        free = shutil.disk_usage(exports_dir).free
    except OSError:
        free = 0
    size = os.path.getsize(path)
    if free < size * 12 // 10 + 64 * 1024 * 1024:
        lines.append('мало места на диске для выдачи копии')
        return 1
    target = os.path.join(exports_dir, request_id + '.dump')
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as out, open(path, 'rb') as source:
            shutil.copyfileobj(source, out, 1024 * 1024)
        if EXPORT_OWNER:
            shutil.chown(target, user=EXPORT_OWNER)
    except Exception:
        try:
            os.unlink(target)
        except OSError:
            pass
        raise
    write_atomic(last_export_file, json.dumps({'at': now(), 'id': backup_id, 'by': by}, ensure_ascii=False))
    lines.append('копия подготовлена к скачиванию (' + str(size) + ' байт); файл будет удалён после скачивания')
    return 0


def purge_exports():
    """Выданные, но не скачанные копии не лежат дольше получаса: в них вся база."""
    try:
        names = os.listdir(exports_dir)
    except OSError:
        return
    for name in names:
        path = os.path.join(exports_dir, name)
        try:
            if time.time() - os.lstat(path).st_mtime > EXPORT_TTL:
                os.unlink(path)
        except OSError:
            continue


def run_backup(request, request_id, log_path, run):
    """Заявки на копии: создать сейчас, проверить, выдать для скачивания."""
    lines = []
    action = request['action']
    try:
        if action == 'backup-create':
            lines.append('$ zvonix-backup manual')
            code, output = run_long(BACKUP_CMD + ['manual'], 3600)
            lines.append(output.strip()[-3000:])
        elif action == 'backup-verify':
            code = verify_backup(request['target'], lines)
        else:
            code = export_backup(request['target'], request_id, request['by'], lines)
    except Exception as error:  # noqa: BLE001 — сбой одной заявки не должен ронять службу
        lines.append('не удалось: ' + str(error))
        code = 1
    with open(log_path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(line for line in lines if line) + '\n')
    os.chmod(log_path, 0o644)
    write_backups()
    write_state(run, status='succeeded' if code == 0 else 'failed', finished_at=now(), exit_code=code)


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
    # Состояние сертификата обновляется при каждом запуске (таймер — раз в десять минут): даты
    # и таймер продления в кабинете не старше этого срока.
    try:
        cert_status()
    except Exception as error:  # noqa: BLE001 — сбой чтения сертификата не должен ронять выкладку
        print('состояние сертификата не записано: ' + str(error), file=sys.stderr)
    # Список копий и выданные файлы — при каждом запуске (таймер раз в десять минут): суточная копия появляется в
    # кабинете без заявки, а невзятая выдача не лежит дольше получаса.
    try:
        write_backups()
        purge_exports()
    except Exception as error:  # noqa: BLE001 — сбой чтения копий не должен ронять выкладку
        print('список копий не записан: ' + str(error), file=sys.stderr)
    prune_runs()


if __name__ == '__main__':
    main()
