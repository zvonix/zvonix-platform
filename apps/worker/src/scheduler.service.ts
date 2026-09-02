/**
 * Расписание фоновых задач поверх BullMQ (ADR-0020).
 *
 * Расписание живёт в Redis, а не в таймере процесса: перезапуск воркера его не сбрасывает
 * и не удваивает, а из нескольких экземпляров задание получает ровно один — это и есть
 * взаимное исключение, ради которого здесь очередь, а не `setInterval`.
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, APP_LOGGER, type Config, type Logger } from '@zvonix/api';
import { internal } from '@zvonix/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { redisConnectionOptions } from './redis.js';
import { BackgroundTasks, type BackgroundTask } from './tasks.js';

/** Пространство имён ключей в Redis. Отделяет очередь от всего остального в той же базе. */
export const QUEUE_PREFIX = 'zvonix';

/** Единственная очередь: все задачи здесь — уборка, и разделять их пока незачем. */
export const QUEUE_NAME = 'maintenance';

/**
 * Сколько заданий обрабатывается одновременно.
 *
 * Два, и это не про пропускную способность: проходы упираются в базу, а не в процессор,
 * и гнать их пачками незачем. Два нужно, чтобы **медленный проход не задерживал срочный**.
 * Единственный проход, который ходит наружу, — удаление записей: при недоступном
 * хранилище каждое удаление ждёт свой тайм-аут, и партия из двух сотен растягивается
 * на десятки минут. При одном обработчике всё это время не снимались бы замолчавшие узлы
 * и не освобождались резервы — то есть отказ хранилища останавливал бы уборку денег.
 *
 * Больше двух не нужно: наружу ходит ровно один проход. Перекрытие задачи самой с собой
 * безопасно — идемпотентность и отбор по сроку требуются от каждой (ADR-0020).
 */
const CONCURRENCY = 2;

/**
 * Сколько заданий хранится после завершения.
 *
 * Не косметика: при `maxmemory-policy noeviction` переполненный Redis перестаёт принимать
 * **любые** записи, а не только историю заданий. Неограниченная история — это отложенный
 * отказ всей очереди, поэтому пределы заданы явно.
 */
const KEEP_COMPLETED = 50;
const KEEP_FAILED = 200;

/**
 * Сколько раз повторить упавший проход и с каким отступом.
 *
 * Немного: проходы догоняющие, и пропущенное подберёт следующий тик. Повторы нужны
 * не для надёжности уборки, а чтобы кратковременный сбой базы не оставлял в журнале
 * запись об ошибке там, где ошибки по существу не было.
 */
const ATTEMPTS = 2;
const BACKOFF_DELAY_MS = 5000;

interface SweepJobResult {
  readonly processed: number;
}

@Injectable()
export class SchedulerService implements OnApplicationShutdown {
  private readonly logger: Logger;

  /**
   * Реестр разбирается в конструкторе, а не при запуске расписания.
   *
   * Так один проход можно выполнить, не поднимая очередь: это нужно проверкам, а на живой
   * системе — разбору «почему уборка не сработала», где очередь как раз под подозрением.
   */
  private readonly registry: readonly BackgroundTask[];
  private readonly tasksByName: ReadonlyMap<string, BackgroundTask>;

  private queue: Queue<Record<string, never>, SweepJobResult> | undefined;
  private worker: Worker<Record<string, never>, SweepJobResult> | undefined;

  constructor(
    private readonly tasks: BackgroundTasks,
    @Inject(APP_CONFIG) private readonly config: Config,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('scheduler');
    this.registry = this.tasks.list();
    this.tasksByName = new Map(this.registry.map((task) => [task.name, task]));

    if (this.tasksByName.size !== this.registry.length) {
      // Две задачи с одним именем — это одно расписание и одна из них, которая
      // не выполняется никогда. Молча такое не обнаруживается.
      throw internal('В реестре фоновых задач есть повторяющиеся имена');
    }
  }

  /**
   * Поднимает очередь, приводит расписание в соответствие с реестром и начинает работу.
   *
   * Вызывается явно из точки входа, а не хуком жизненного цикла: проверкам нужно поднимать
   * контекст приложения, не запуская при этом настоящее расписание.
   */
  async start(): Promise<void> {
    if (this.queue !== undefined) return;

    // Очередь и рабочий процесс получают настройки, а не общее соединение: рабочий
    // читает очередь блокирующей командой и на время ожидания занимает соединение
    // целиком, а закрывать их должен тот, кто открыл.
    const connection = redisConnectionOptions(this.config.REDIS_URL);

    const queue = new Queue<Record<string, never>, SweepJobResult>(QUEUE_NAME, {
      connection,
      prefix: QUEUE_PREFIX,
    });
    this.queue = queue;

    await this.reconcileSchedules(queue);

    this.worker = new Worker<Record<string, never>, SweepJobResult>(
      QUEUE_NAME,
      (job) => this.process(job),
      { connection, prefix: QUEUE_PREFIX, concurrency: CONCURRENCY },
    );

    this.worker.on('failed', (job, error) => {
      this.logger.error('Проход завершился ошибкой', error, {
        task: job?.name ?? 'неизвестно',
        attempt: job?.attemptsMade ?? 0,
      });
    });

    // Ошибки самого рабочего процесса — это обрыв связи с Redis и подобное. Их нужно
    // видеть отдельно от ошибок прохода: первое чинится инфраструктурой, второе кодом.
    this.worker.on('error', (error) => {
      this.logger.error('Ошибка очереди', error);
    });

    // Дожидаемся готовности обоих соединений: иначе недоступный Redis не мешает
    // запуску, и процесс выглядит работающим, ничего не выполняя.
    await queue.waitUntilReady();
    await this.worker.waitUntilReady();

    this.logger.info('Расписание фоновых задач запущено', {
      tasks: this.registry.map((task) => `${task.name}/${String(task.everySeconds)}с`).join(' '),
    });
  }

  /**
   * Приводит расписание в Redis к реестру задач.
   *
   * Обязательный шаг, а не удобство: расписание переживает перезапуск, поэтому
   * переименованная или удалённая задача оставила бы в Redis сироту, которая продолжает
   * выпускать задания. Их некому обработать, они копятся и упираются в предел памяти —
   * а при `noeviction` это отказ всей очереди.
   */
  private async reconcileSchedules(
    queue: Queue<Record<string, never>, SweepJobResult>,
  ): Promise<void> {
    const wanted = new Set(this.registry.map((task) => task.name));

    for (const existing of await queue.getJobSchedulers()) {
      if (wanted.has(existing.key)) continue;
      await queue.removeJobScheduler(existing.key);
      this.logger.warn('Снято расписание задачи, которой больше нет', { task: existing.key });
    }

    for (const task of this.registry) {
      await queue.upsertJobScheduler(
        task.name,
        { every: task.everySeconds * 1000 },
        {
          name: task.name,
          data: {},
          opts: {
            removeOnComplete: { count: KEEP_COMPLETED },
            removeOnFail: { count: KEEP_FAILED },
            attempts: ATTEMPTS,
            backoff: { type: 'exponential', delay: BACKOFF_DELAY_MS },
          },
        },
      );
    }
  }

  private async process(job: Job<Record<string, never>, SweepJobResult>): Promise<SweepJobResult> {
    return { processed: await this.runTask(job.name) };
  }

  /**
   * Выполняет один проход задачи.
   *
   * Ошибку не глотает намеренно: упавший проход обязан упасть. Проход, поймавший
   * исключение и отчитавшийся об успехе, — это уборка, которая не выполняется,
   * и узнают об этом по последствиям, а не по журналу.
   */
  async runTask(name: string, now: Date = new Date()): Promise<number> {
    const task = this.tasksByName.get(name);
    if (task === undefined) {
      // Задание от расписания, которого больше нет в реестре. Сверка при старте такие
      // снимает, но задание могло быть выпущено до неё другим экземпляром.
      throw internal(`Фоновая задача «${name}» не найдена в реестре`);
    }

    const started = Date.now();
    const processed = await task.run(now);
    const elapsedMs = Date.now() - started;

    if (task.batchLimit !== undefined && processed >= task.batchLimit) {
      // Проход взял ровно столько, сколько ему разрешено, — значит работа поступает
      // быстрее, чем убирается. Само по себе это не ошибка, но отставание будет расти,
      // и заметить его больше неоткуда.
      this.logger.warn('Проход упёрся в предел партии: уборка отстаёт от поступления', {
        task: name,
        processed,
        batch_limit: task.batchLimit,
      });
    }

    const fields = { task: name, processed, elapsed_ms: elapsedMs };
    if (processed > 0) this.logger.info('Проход выполнен', fields);
    else this.logger.debug('Проход выполнен, работы не было', fields);

    return processed;
  }

  /** Реестр задач, как он собран в этом процессе. */
  registeredTasks(): readonly BackgroundTask[] {
    return this.registry;
  }

  /** Имена задач, расписание которых сейчас заведено в Redis. */
  async scheduledTaskNames(): Promise<string[]> {
    if (this.queue === undefined) return [];
    return (await this.queue.getJobSchedulers()).map((scheduler) => scheduler.key).sort();
  }

  /**
   * Останавливает работу, дожидаясь текущих проходов.
   *
   * Обрывать нельзя: проход, убитый посреди удаления записей, оставит объект в хранилище
   * без отметки в базе — то есть разговор, который считается удалённым, но лежит.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    // Соединения закрывает BullMQ: они его, и только он знает, что на них ещё висит.
    await this.worker?.close();
    await this.queue?.close();
    this.worker = undefined;
    this.queue = undefined;
  }
}
