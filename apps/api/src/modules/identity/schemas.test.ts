import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema } from './schemas.js';

const valid = {
  email: 'ivan@example.com',
  password: 'достаточно длинный пароль',
  fullName: 'Иван Петров',
  cabinet: 'client' as const,
  answers: { companyName: 'Такси Мир', city: 'Екатеринбург', phone: '+7 900 000-00-00' },
};

const partner = {
  ...valid,
  cabinet: 'partner' as const,
  answers: { region: 'Свердловская область', phone: '+7 900 000-00-00', operators: ['МТС'] },
};

describe('схема регистрации', () => {
  it('принимает корректные данные', () => {
    expect(registerSchema.parse(valid).email).toBe('ivan@example.com');
  });

  it('приводит адрес к нижнему регистру и обрезает пробелы', () => {
    // В базе стоит ограничение `email = lower(email)`: без приведения здесь
    // регистр из формы вызвал бы отказ вставки, а не понятную ошибку.
    expect(registerSchema.parse({ ...valid, email: '  Ivan@Example.COM ' }).email).toBe(
      'ivan@example.com',
    );
  });

  it('отвергает короткий пароль', () => {
    expect(registerSchema.safeParse({ ...valid, password: 'короткий' }).success).toBe(false);
  });

  it('отвергает пароль неограниченной длины', () => {
    // Иначе мегабайтная строка займёт процессор на хешировании — это бесплатный отказ
    // в обслуживании на публичном обработчике.
    expect(registerSchema.safeParse({ ...valid, password: 'я'.repeat(201) }).success).toBe(false);
  });

  it('не позволяет заявиться сотрудником площадки', () => {
    // Роли admin и support заводит только команда admin:create — иначе доступ ко всей
    // платформе получает любой, кто отправил форму. Заявка бывает только на кабинет.
    expect(registerSchema.safeParse({ ...valid, cabinet: 'admin' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, role: 'admin' }).success).toBe(true);
    expect(registerSchema.parse({ ...valid, role: 'admin' })).not.toHaveProperty('role');
  });

  it('принимает заявку и клиента, и партнёра — каждую со своей анкетой', () => {
    expect(registerSchema.safeParse(valid).success).toBe(true);
    expect(registerSchema.safeParse(partner).success).toBe(true);
  });

  it('анкета одного кабинета не подходит к другому', () => {
    // Иначе партнёр мог бы прислать анкету службы такси без операторов своих SIM,
    // и администратору было бы нечего сверять.
    expect(registerSchema.safeParse({ ...valid, cabinet: 'partner' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...partner, cabinet: 'client' }).success).toBe(false);
  });

  it('анкеты нет: заявка проходит с пустыми ответами (владелец, 2026-09-30)', () => {
    // Клиент — не только служба такси, а человек, который звонит друзьям: телефон и название
    // у него не спрашиваются. Поля остаются допустимыми ради заявок, поданных раньше.
    for (const cabinet of ['client', 'partner'] as const) {
      expect(registerSchema.safeParse({ ...valid, cabinet, answers: {} }).success).toBe(true);
    }
  });

  it('неверно заполненное необязательное поле всё равно отвергается', () => {
    expect(
      registerSchema.safeParse({ ...partner, answers: { ...partner.answers, operators: [''] } })
        .success,
    ).toBe(false);
  });

  it('лишние поля анкеты отвергаются, а не хранятся молча', () => {
    expect(
      registerSchema.safeParse({ ...valid, answers: { ...valid.answers, лишнее: 'да' } }).success,
    ).toBe(false);
  });

  it('отвергает адрес, не похожий на почту', () => {
    expect(registerSchema.safeParse({ ...valid, email: 'не почта' }).success).toBe(false);
  });
});

describe('схема входа', () => {
  it('не требует длины пароля', () => {
    // Требование длины при входе рассказало бы, каким правилам подчиняются
    // существующие пароли, и сузило бы перебор.
    expect(loginSchema.safeParse({ email: 'ivan@example.com', password: 'x' }).success).toBe(true);
  });

  it('отвергает пустой пароль', () => {
    expect(loginSchema.safeParse({ email: 'ivan@example.com', password: '' }).success).toBe(false);
  });
});
