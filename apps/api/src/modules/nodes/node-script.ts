/**
 * Скрипт установки узла в стандартный вывод: `node dist/modules/nodes/node-script.js`
 * ([ADR-0109](../../../../../docs/adr/0109-podlinnost-vypuska-i-prava-na-kod.md)).
 *
 * Тот же скрипт, что отдаёт `GET /install.sh`, но собранный из кода выпуска, а не работающим API. Его зовёт выкладка
 * (`deploy/deploy.sh`), чтобы обновить узел на той же машине: скрипт исполняет root, и брать его у API нельзя —
 * взломанный API получил бы root. Здесь код лежит в каталоге выпуска, который принадлежит root и подписан.
 *
 * Нужно окружение площадки: в скрипт подставляются её адрес и репозиторий пакетов.
 */

// Декораторы Nest на классе сервиса пишут метаданные при загрузке модуля.
import 'reflect-metadata';
import { loadConfig } from '@zvonix/config';
import { NodeSetService } from './node-set.service.js';

try {
  process.stdout.write(await new NodeSetService(loadConfig()).script());
} catch (cause) {
  process.stderr.write(`Скрипт узла не собран: ${String(cause)}\n`);
  process.exitCode = 1;
}
