/**
 * Подставные команды для проверок службы обновления: PostgreSQL, `zvonix-backup`, `systemctl`, проба готовности и
 * миграции. Один Python-скрипт на команду; всё, что вызвано, пишется в `calls.log` рабочего каталога проверки.
 * Поведение переключается переменными `FAKE_*` — каждая проверка включает ровно тот сбой, который ей нужен.
 */

/** PostgreSQL: имя команды — первый аргумент. */
export const FAKE_PG = `
import os, sys
name, args = sys.argv[1], sys.argv[2:]
fake = os.environ["FAKE_DIR"]
with open(fake + "/calls.log", "a") as log:
    log.write(name + " " + " ".join(args) + "\\n")
fail = os.environ.get("FAKE_FAIL_STATEMENT")
if fail and fail in " ".join(args):
    print("ERROR: simulated failure")
    sys.exit(1)
if name == "pg_restore" and args[0] == "--list":
    count = 3 if os.environ.get("FAKE_FEW_TABLES") else 12
    for n in range(count):
        print("%d; 1259 %d TABLE public t%d zvonix" % (n, n, n))
    print("; Archive created")
elif name == "pg_restore":
    if os.environ.get("FAKE_RESTORE_FAIL"):
        print("pg_restore: error: could not execute query")
        sys.exit(1)
elif name == "psql":
    query = args[-1]
    if "pg_database" in query:
        try:
            print(open(fake + "/databases.txt").read().strip())
        except OSError:
            pass
    elif "information_schema" in query:
        print("14")
    elif query.endswith("users"):
        print("3")
    elif query.endswith("payments"):
        print("ERROR: relation does not exist")
        sys.exit(1)
    elif query.startswith("select count"):
        print("0")
`;

/** \`zvonix-backup <вид>\`: кладёт файл копии нужного вида; \`FAKE_BACKUP_FAIL\` — не снимает. */
export const FAKE_BACKUP = `
import os, sys
kind = sys.argv[1]
with open(os.environ["FAKE_DIR"] + "/calls.log", "a") as log:
    log.write("zvonix-backup " + kind + "\\n")
if os.environ.get("FAKE_BACKUP_FAIL"):
    print("Ошибка: копия базы не снята")
    sys.exit(1)
directory = os.environ["FAKE_DIR"] + "/backups/" + kind
os.makedirs(directory, exist_ok=True)
with open(directory + "/" + kind + "-20261019-120000.dump", "wb") as f:
    f.write(b"new")
print("копия базы: снята (" + kind + ")")
`;

export const FAKE_SYSTEMCTL = `
import os, sys
with open(os.environ["FAKE_DIR"] + "/calls.log", "a") as log:
    log.write("systemctl " + " ".join(sys.argv[1:]) + "\\n")
if os.environ.get("FAKE_STOP_FAIL") and sys.argv[1] == "stop":
    sys.exit(1)
`;

/** Проба готовности: «не готова», пока в рабочем каталоге есть файл \`not-ready\`. */
export const FAKE_READY = `
import os, sys
sys.exit(1 if os.path.exists(os.environ["FAKE_DIR"] + "/not-ready") else 0)
`;

export const FAKE_MIGRATE = `
import os, sys
with open(os.environ["FAKE_DIR"] + "/calls.log", "a") as log:
    log.write("migrate\\n")
if os.environ.get("FAKE_MIGRATE_FAIL"):
    print("migrate: failed")
    sys.exit(1)
`;
