'use client';

import { useEffect, useRef } from 'react';

/**
 * Виджет Яндекс SmartCaptcha ([ADR-0031](../../../../docs/adr/0031-nastroyki-ploshchadki.md)).
 *
 * Рисуется только тогда, когда площадка сказала, что на этой форме капча включена
 * (`GET /auth/captcha`). Ключ страницы публичен по устройству SmartCaptcha — он и так
 * уезжает в браузер, — а проверка токена делается на сервере.
 *
 * Сценарий грузится с чужого адреса, и его недоступность — штатный случай.
 * Тогда токена не будет, форма отправится без него, и решать будет сервер:
 * он пропускает запрос и пишет ошибку в журнал. Тот же довод, что и у счётчика
 * ограничений частоты, — отказ на этом месте закрыл бы вход **всем**, включая
 * администратора, которому это и чинить.
 */
declare global {
  interface Window {
    smartCaptcha?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          hl?: string;
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
        },
      ) => number;
      destroy?: (widgetId: number) => void;
    };
  }
}

const SCRIPT_ID = 'yandex-smartcaptcha';
const SCRIPT_SRC = 'https://smartcaptcha.yandexcloud.net/captcha.js';

/** Один сценарий на страницу, сколько бы виджетов на ней ни было. */
function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.smartCaptcha !== undefined) {
      resolve();
      return;
    }

    const existing = document.getElementById(SCRIPT_ID);
    if (existing !== null) {
      existing.addEventListener('load', () => {
        resolve();
      });
      existing.addEventListener('error', () => {
        reject(new Error('Сценарий капчи не загрузился'));
      });
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.defer = true;
    script.addEventListener('load', () => {
      resolve();
    });
    script.addEventListener('error', () => {
      reject(new Error('Сценарий капчи не загрузился'));
    });
    document.head.append(script);
  });
}

export function YandexCaptcha({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | undefined) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  // Обработчик держится в ссылке, чтобы его замена не перерисовывала виджет:
  // перерисовка сбрасывает уже пройденную проверку.
  const notify = useRef(onToken);
  notify.current = onToken;

  useEffect(() => {
    let widgetId: number | undefined;
    let cancelled = false;

    void loadScript()
      .then(() => {
        if (cancelled || container.current === null) return;
        widgetId = window.smartCaptcha?.render(container.current, {
          sitekey: siteKey,
          hl: 'ru',
          callback: (token) => {
            notify.current(token);
          },
          'expired-callback': () => {
            notify.current(undefined);
          },
        });
      })
      .catch(() => {
        // Молчим намеренно: без токена форма отправится, и решать будет сервер.
        notify.current(undefined);
      });

    return () => {
      cancelled = true;
      if (widgetId !== undefined) window.smartCaptcha?.destroy?.(widgetId);
    };
  }, [siteKey]);

  return <div ref={container} />;
}
