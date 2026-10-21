'use client';

import { ImagePlus, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import { Hint } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { request } from '@/lib/api';
import {
  TICKET_IMAGE_MAX_BYTES,
  TICKET_IMAGE_TYPES,
  TICKET_IMAGES_PER_MESSAGE,
  type TicketImageType,
} from '@zvonix/shared';

/** Файл, уже загруженный на сервер и ждущий отправки вместе с сообщением. */
interface Picked {
  readonly id: string;
  readonly name: string;
  /** Адрес для предпросмотра из памяти браузера: файл не нужно скачивать обратно. */
  readonly preview: string;
}

const MIME_OK = new Set<string>(TICKET_IMAGE_TYPES.map((type) => `image/${type}`));

const isImageType = (value: string): value is `image/${TicketImageType}` => MIME_OK.has(value);

/**
 * Картинки к сообщению ([ADR-0089](../../../../docs/adr/0089-obrashcheniya-statusy-i-kartinki.md)): выбор файла, перетаскивание и
 * вставка из буфера (Ctrl+V). Каждая загружается сразу и ждёт отправки; идентификаторы уходят в самом сообщении.
 */
export function useTicketImages() {
  const [items, setItems] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const known = useRef<Picked[]>([]);
  known.current = items;

  // Адреса предпросмотра освобождаются, когда поле исчезло.
  useEffect(
    () => () => {
      for (const item of known.current) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const add = useCallback(async (files: readonly File[]): Promise<void> => {
    setError(undefined);
    for (const file of files) {
      if (known.current.length >= TICKET_IMAGES_PER_MESSAGE) {
        setError(`Не больше ${String(TICKET_IMAGES_PER_MESSAGE)} картинок на сообщение`);
        return;
      }
      if (!isImageType(file.type)) {
        setError('Можно только PNG, JPEG и WebP');
        continue;
      }
      if (file.size > TICKET_IMAGE_MAX_BYTES) {
        setError('Картинка больше 5 МБ');
        continue;
      }
      setBusy((count) => count + 1);
      try {
        const name = file.name === '' ? `картинка.${file.type.slice(6)}` : file.name;
        const saved = await request<{ id: string }>(
          `/storage/support/attachments?name=${encodeURIComponent(name)}`,
          { method: 'POST', file, timeoutMs: 120_000 },
        );
        const picked: Picked = { id: saved.id, name, preview: URL.createObjectURL(file) };
        known.current = [...known.current, picked];
        setItems(known.current);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Не получилось загрузить картинку');
      } finally {
        setBusy((count) => count - 1);
      }
    }
  }, []);

  const remove = useCallback((id: string): void => {
    const gone = known.current.find((item) => item.id === id);
    if (gone !== undefined) URL.revokeObjectURL(gone.preview);
    known.current = known.current.filter((item) => item.id !== id);
    setItems(known.current);
    setError(undefined);
  }, []);

  /** После отправки: список пуст, адреса освобождены (сами файлы теперь прикреплены к сообщению). */
  const clear = useCallback((): void => {
    for (const item of known.current) URL.revokeObjectURL(item.preview);
    known.current = [];
    setItems([]);
    setError(undefined);
  }, []);

  /** Вставка из буфера: берутся только картинки, текст вставляется как обычно. */
  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLElement>): void => {
      const files = [...event.clipboardData.items]
        .filter((item) => item.kind === 'file' && isImageType(item.type))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (files.length === 0) return;
      event.preventDefault();
      void add(files);
    },
    [add],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      if (event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      void add([...event.dataTransfer.files]);
    },
    [add],
  );

  return {
    items,
    ids: items.map((item) => item.id),
    busy: busy > 0,
    error,
    add,
    remove,
    clear,
    onPaste,
    onDrop,
  };
}

export type TicketImages = ReturnType<typeof useTicketImages>;

/** Строка под полем текста: выбранные картинки миниатюрами и кнопка «Прикрепить»; пояснение — за значком «?». */
export function TicketImagesBar({ images }: { images: TicketImages }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          accept={TICKET_IMAGE_TYPES.map((type) => `image/${type}`).join(',')}
          className="sr-only"
          aria-label="Файлы картинок"
          tabIndex={-1}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            void images.add(files);
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={images.busy || images.items.length >= TICKET_IMAGES_PER_MESSAGE}
          onClick={() => {
            input.current?.click();
          }}
        >
          <ImagePlus size={14} aria-hidden /> {images.busy ? 'Загружаем…' : 'Прикрепить картинку'}
        </Button>
        <Hint label="Про картинки">
          <p>
            PNG, JPEG или WebP, до {String(TICKET_IMAGES_PER_MESSAGE)} штук по 5 МБ. Картинку можно
            вставить из буфера обмена (Ctrl+V) или перетащить в поле текста.
          </p>
        </Hint>
        {images.items.map((item) => (
          <span
            key={item.id}
            className="relative inline-flex overflow-hidden rounded-md border border-border"
          >
            {/* Предпросмотр из памяти браузера (blob:), поэтому обычный img, а не оптимизатор изображений. */}
            <img src={item.preview} alt={item.name} className="size-14 object-cover" />
            <button
              type="button"
              aria-label={`Убрать ${item.name}`}
              onClick={() => {
                images.remove(item.id);
              }}
              className="absolute right-0 top-0 inline-flex size-5 items-center justify-center bg-background/80 hover:bg-background"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
      </div>
      {images.error !== undefined && (
        <p role="alert" className="text-crit">
          {images.error}
        </p>
      )}
    </div>
  );
}

/** Картинки уже отправленного сообщения: миниатюры, по нажатию открываются целиком в новой вкладке. */
export function MessageImages({
  files,
}: {
  files: readonly { id: string; name: string; size: number }[];
}) {
  if (files.length === 0) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-2">
      {files.map((file) => (
        <a
          key={file.id}
          href={`/api/support/attachments/${file.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title={file.name}
          className="overflow-hidden rounded-md border border-border"
        >
          {/* Картинка из закрытого API с cookie сессии: оптимизатор Next не может её получить. */}
          <img
            src={`/api/support/attachments/${file.id}`}
            alt={file.name}
            loading="lazy"
            className="max-h-40 max-w-[16rem] object-cover"
          />
        </a>
      ))}
    </span>
  );
}
