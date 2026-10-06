/**
 * Плотность таблиц: обычная или плотная.
 *
 * Админке нужна плотность ([DESIGN.md](../../../../docs/DESIGN.md), «Три аудитории»), но не всем и не всегда:
 * выбор — за человеком. Он ставит `data-density="compact"` на корень документа, а размеры строк меняет
 * `globals.css` для всех таблиц сразу — без правки каждой страницы. Выбор живёт в браузере, как тема.
 */

export type Density = 'normal' | 'compact';

export const DENSITY_STORAGE_KEY = 'zvonix.density';

export const isDensity = (value: unknown): value is Density =>
  value === 'normal' || value === 'compact';

export function applyDensity(density: Density): void {
  const root = document.documentElement;
  if (density === 'compact') root.setAttribute('data-density', 'compact');
  else root.removeAttribute('data-density');
}

/** Выставляет плотность до первой отрисовки, как и тему: иначе таблицы дёрнутся после загрузки. */
export const DENSITY_BOOTSTRAP_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  DENSITY_STORAGE_KEY,
)})==='compact')document.documentElement.setAttribute('data-density','compact')}catch(e){}`;
