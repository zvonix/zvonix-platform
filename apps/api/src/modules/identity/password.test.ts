import { describe, expect, it } from 'vitest';
import {
  burnVerificationTime,
  EXPECTED_HASH_PREFIX,
  hashPassword,
  verifyPassword,
} from './password.js';

describe('пароли', () => {
  it('использует argon2id версии 19', async () => {
    // Алгоритм и версия не задаются в коде (их типы недоступны при verbatimModuleSyntax),
    // поэтому умолчание библиотеки проверяется здесь. Смена умолчания в новой версии
    // должна ломать эту проверку, а не остаться незамеченной.
    expect((await hashPassword('достаточно длинный пароль')).startsWith(EXPECTED_HASH_PREFIX)).toBe(
      true,
    );
  });

  it('кодирует параметры стойкости внутри хеша', async () => {
    // Благодаря этому изменение параметров не ломает уже выданные хеши.
    expect(await hashPassword('достаточно длинный пароль')).toContain('m=19456,t=2,p=1');
  });

  it('даёт разные хеши одному паролю', async () => {
    // Соль случайна: одинаковые хеши означали бы, что по базе видно, у кого пароли совпадают.
    const [first, second] = await Promise.all([
      hashPassword('один и тот же'),
      hashPassword('один и тот же'),
    ]);
    expect(first).not.toBe(second);
  });

  it('подтверждает верный пароль и отвергает неверный', async () => {
    const hashed = await hashPassword('правильный пароль');
    await expect(verifyPassword('правильный пароль', hashed)).resolves.toBe(true);
    await expect(verifyPassword('неправильный пароль', hashed)).resolves.toBe(false);
  });

  it('считает испорченный хеш несовпадением, а не сбоем', async () => {
    // Строка из базы может оказаться повреждённой; это отказ входа, а не 500.
    await expect(verifyPassword('пароль', 'не хеш вовсе')).resolves.toBe(false);
    await expect(verifyPassword('пароль', '')).resolves.toBe(false);
  });

  it('сжигает время при отсутствии учётной записи', async () => {
    // Без этого ответ на неизвестный адрес заметно быстрее, и по времени
    // собирается список зарегистрированных адресов.
    const started = process.hrtime.bigint();
    await burnVerificationTime('любой пароль');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeGreaterThan(1);
  });
});
