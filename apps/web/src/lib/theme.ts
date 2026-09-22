/**
 * Тема оформления: светлая, тёмная или как в системе.
 *
 * Состояний три, а не два. Выбор человека ставит `data-theme` на корне документа;
 * «как в системе» не ставит ничего, и тогда тему выбирает `prefers-color-scheme`.
 * Палитра для всех трёх состояний задана в `globals.css`.
 */

export type Theme = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'zvonix.theme';

export function isTheme(value: unknown): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * Применяет выбор к документу.
 *
 * «Как в системе» снимает атрибут, а не ставит вычисленное значение: иначе выбор
 * перестал бы следовать за системой, когда она переключается на ходу.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/**
 * Сценарий, который выставляет тему **до первой отрисовки**.
 *
 * Без него страница успевает мигнуть светлым у того, кто выбрал тёмную:
 * React примонтируется уже после того, как браузер нарисует первый кадр.
 * Поэтому это строка для `<head>`, а не эффект в компоненте.
 *
 * Хранилище оборачивается в `try`: в приватном окне и при запрете данных сайта
 * обращение к нему бросает исключение, и страница осталась бы без разметки вовсе.
 */
export const THEME_BOOTSTRAP_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
