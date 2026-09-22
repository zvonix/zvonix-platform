/**
 * Дождаться работы, но не дольше `ms`.
 *
 * Подтверждаемая мутация ждёт обновления экрана, чтобы окно закрылось уже на новом
 * состоянии и фокус встал рядом, а не на исчезающую кнопку (`ConfirmAction`). Но обновление —
 * это повторный запрос с повторами при отказе: без предела окно после **успешного**
 * действия висело бы на «Выполняем…» секундами, а при зависшем запросе — до конца.
 * Не успело — окно закрывается, а обновление доходит само.
 */
export async function atMost(work: Promise<unknown>, ms = 1500): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}
