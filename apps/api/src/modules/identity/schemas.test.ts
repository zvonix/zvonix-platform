import { describe, expect, it } from 'vitest';
import { loginSchema, registerSchema } from './schemas.js';

const valid = {
  email: 'ivan@example.com',
  password: 'достаточно длинный пароль',
  fullName: 'Иван Петров',
  role: 'client' as const,
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

  it('не позволяет зарегистрироваться администратором', () => {
    // Роли admin и support заводит только администратор — иначе доступ ко всей
    // платформе получает любой, кто отправил форму.
    expect(registerSchema.safeParse({ ...valid, role: 'admin' }).success).toBe(false);
    expect(registerSchema.safeParse({ ...valid, role: 'support' }).success).toBe(false);
  });

  it('принимает обе роли самостоятельной регистрации', () => {
    expect(registerSchema.safeParse({ ...valid, role: 'partner' }).success).toBe(true);
    expect(registerSchema.safeParse({ ...valid, role: 'client' }).success).toBe(true);
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
