/**
 * Набор узла: скрипт установки, собранный под эту площадку, и его версия
 * ([ADR-0045](../../../../../docs/adr/0045-ustanovshchik-uzla.md),
 * [ADR-0068](../../../../../docs/adr/0068-avtoobnovlenie-uzlov.md)).
 *
 * **Версия набора — отпечаток собранного скрипта**, а не номер выпуска: узел обновляется,
 * только когда изменилось то, что на него ставится. Выпуск, правивший один лишь API,
 * узлы не трогает.
 */

import { Injectable } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { dependencyUnavailable } from '@zvonix/shared';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

/**
 * Каталог `node/` разрешается от этого файла, а не от рабочего каталога процесса —
 * тем же способом, что и каталог миграций в `@zvonix/db`. Собранный код лежит
 * в `apps/api/dist/modules/nodes`, исходный — в `apps/api/src/modules/nodes`:
 * глубина одинаковая, и путь наверх один и тот же.
 */
const NODE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'node',
);

const INSTALL_SCRIPT = path.join(NODE_DIR, 'install.sh');
/** Набор конфигурации узла целиком ([ADR-0051](../../../../../docs/adr/0051-svoya-konfiguraciya-uzla.md)). */
const CONF_DIR = path.join(NODE_DIR, 'conf');

/** Фильтр и тюрьма fail2ban для подбора паролей SIP — раскладываются в /etc/fail2ban. */
const FAIL2BAN_DIR = path.join(NODE_DIR, 'fail2ban');

/** Граница вложенного файла в скрипте: строки с ней в файлах набора быть не может. */
const CONF_EOF = 'ZVONIX_CONF_EOF';

/**
 * Имя файла набора ложится в скрипт в одинарных кавычках: латиница, цифры и `_./-`,
 * без выхода наверх. Иначе имя стало бы кодом, исполняемым на узле от root.
 */
/** Метка версии набора в `node/install.sh`. */
const VERSION_MARK = '@@SET_VERSION@@';

const CONF_NAME = /^(?!.*\.\.)[a-z0-9_][a-z0-9_./-]*$/u;

@Injectable()
export class NodeSetService {
  /** Версия не меняется, пока работает процесс: набор лежит в артефакте выпуска. */
  private cachedVersion: Promise<string> | undefined;

  constructor(@Inject(APP_CONFIG) private readonly config: Config) {}

  /** Скрипт установки для узла с этой площадки, с версией набора внутри. */
  async script(): Promise<string> {
    const [built, version] = await Promise.all([this.build(), this.version()]);
    return built.replaceAll(VERSION_MARK, () => version);
  }

  /** Версия набора — первые 12 знаков SHA-256 скрипта с пустой меткой версии (в неё сама версия войти не может). */
  version(): Promise<string> {
    this.cachedVersion ??= this.build().then((built) =>
      createHash('sha256')
        .update(built.replaceAll(VERSION_MARK, () => ''))
        .digest('hex')
        .slice(0, 12),
    );
    return this.cachedVersion;
  }

  /**
   * Собирает скрипт: сначала параметры, потом набор конфигурации.
   *
   * Порядок строгий. Обратный затёр бы метки **внутри** вложенных файлов — а их
   * подставляет сам скрипт на узле: ключа до обмена токена не существует, пароль ESL
   * порождается там же.
   *
   * Замена — функцией, а не строкой: в строке замены `replaceAll` читает `$$` как `$`,
   * а набор полон `$${domain}` и `$${local_ip_v4}` — они молча стали бы `${…}`.
   */
  private async build(): Promise<string> {
    const repository = this.config.NODE_PACKAGE_REPO_URL;
    const [source, files] = await Promise.all([this.read(INSTALL_SCRIPT), this.confFiles()]);

    const settings: Record<string, string> = {
      '@@CONTROL_PLANE@@': this.config.PUBLIC_BASE_URL.replace(/\/+$/u, ''),
      '@@SIP_REALM@@': this.config.SIP_REALM,
      '@@PACKAGE_REPO@@': repository.replace(/\/+$/u, ''),
      '@@PACKAGE_SUITE@@': this.config.NODE_PACKAGE_SUITE,
      '@@PACKAGE_KEY_FINGERPRINT@@': this.config.NODE_PACKAGE_KEY_FINGERPRINT,
    };
    let script = source;
    for (const [mark, value] of Object.entries(settings)) {
      script = script.replaceAll(mark, () => value);
    }
    return script
      .replaceAll('@@CONF_FILES@@', () => files.conf)
      .replaceAll('@@FAIL2BAN_FILES@@', () => files.fail2ban);
  }

  /** Файлы набора — вызовами `<функция> <имя> <<'ZVONIX_CONF_EOF'`, по порядку имён. */
  private async confFiles(): Promise<{ conf: string; fail2ban: string }> {
    return {
      conf: await this.embed(CONF_DIR, 'conf_file'),
      fail2ban: await this.embed(FAIL2BAN_DIR, 'fail2ban_file'),
    };
  }

  /** Каталог целиком — блоками `<функция> '<имя>' <<'ZVONIX_CONF_EOF'`. */
  private async embed(directory: string, command: string): Promise<string> {
    let entries;
    try {
      entries = await readdir(directory, { recursive: true, withFileTypes: true });
    } catch {
      throw dependencyUnavailable('Установщик узла недоступен', {
        details: { file: directory, remedy: 'В артефакт выкладки не попал каталог node/.' },
      });
    }
    const names = entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
      )
      .sort();

    const blocks: string[] = [];
    for (const name of names) {
      const content = (await this.read(path.join(directory, name))).trimEnd();
      if (!CONF_NAME.test(name) || content.split('\n').includes(CONF_EOF)) {
        throw dependencyUnavailable('Установщик узла недоступен', {
          details: {
            file: name,
            remedy: `Имя файла набора — латиница, цифры и «_./-»; строки «${CONF_EOF}» в нём быть не может.`,
          },
        });
      }
      blocks.push(`${command} '${name}' <<'${CONF_EOF}'\n${content}\n${CONF_EOF}`);
    }
    return blocks.join('\n');
  }

  /**
   * Чтение файла из `node/`.
   *
   * Отсутствие файла — это неполный артефакт выкладки, а не ошибка запроса: `node/`
   * уезжает вместе с приложением так же, как каталог миграций. Отказ называет путь,
   * иначе разбираться пришлось бы по одному слову «не найдено».
   */
  private async read(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8');
    } catch {
      throw dependencyUnavailable('Установщик узла недоступен', {
        details: { file, remedy: 'В артефакт выкладки не попал каталог node/.' },
      });
    }
  }
}
