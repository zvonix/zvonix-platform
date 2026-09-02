/**
 * Объектное хранилище записей разговоров.
 *
 * За интерфейсом, а не напрямую: хранилище — внешняя система, и проверки не должны
 * зависеть ни от сети, ни от чужой доступности (ADR-0006). Тот же приём, что
 * с определением оператора.
 *
 * **Ключи хранилища есть только у control plane.** Узел их не получает никогда: они дают
 * доступ ко всем записям всех клиентов, и скомпрометированный узел читал бы чужие
 * разговоры. Вместо ключей узел получает подписанную ссылку ровно на один объект.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import { dependencyUnavailable } from '@zvonix/shared';
import { APP_CONFIG, type Config } from '../../infra/tokens.js';

/** Токен внедрения: подменяется в проверках, чтобы не ходить в живое хранилище. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

export interface ObjectStorage {
  /** Ссылка, по которой узел выгружает файл. Действует ограниченное время. */
  presignUpload(objectKey: string, ttlSeconds: number): Promise<string>;
  /** Ссылка, по которой человек слушает запись. Действует ограниченное время. */
  presignDownload(objectKey: string, ttlSeconds: number): Promise<string>;
  /** Удаление объекта по истечении срока хранения. */
  remove(objectKey: string): Promise<void>;
}

@Injectable()
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: Config) {
    this.bucket = config.S3_BUCKET;
    this.client = new S3Client({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      // MinIO и большинство совместимых хранилищ не поддерживают адресацию корзины
      // поддоменом: без этого запросы уходят на несуществующее имя.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
    });
  }

  async presignUpload(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.sign(
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      ttlSeconds,
      'выгрузки',
    );
  }

  async presignDownload(objectKey: string, ttlSeconds: number): Promise<string> {
    return this.sign(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      ttlSeconds,
      'прослушивания',
    );
  }

  async remove(objectKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch (cause) {
      throw dependencyUnavailable('Хранилище записей недоступно', { cause });
    }
  }

  private async sign(
    command: PutObjectCommand | GetObjectCommand,
    ttlSeconds: number,
    purpose: string,
  ): Promise<string> {
    try {
      return await getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
    } catch (cause) {
      // Подписание выполняется локально и сети не требует, но настройка может быть
      // негодной — например, пустые ключи. Отличать это от недоступности хранилища
      // важно: первое чинится конфигурацией, второе ожиданием.
      throw dependencyUnavailable(`Не удалось подписать ссылку для ${purpose}`, { cause });
    }
  }
}

/**
 * Ключ объекта: `recordings/<год>/<месяц>/<вызов>.wav`.
 *
 * Задаёт control plane, а не узел: иначе скомпрометированный узел прислал бы ключ чужой
 * записи и затёр её. Разбиение по годам и месяцам нужно не хранилищу, а человеку —
 * просматривать плоский каталог с миллионом объектов невозможно.
 */
export function recordingObjectKey(callId: string, at: Date): string {
  const year = at.getUTCFullYear().toString();
  const month = (at.getUTCMonth() + 1).toString().padStart(2, '0');
  return `recordings/${year}/${month}/${callId}.wav`;
}
