import { describe, expect, it } from 'vitest';
import {
  emailVerificationLetter,
  passwordResetLetter,
  registrationAttemptLetter,
} from './letters.js';

const BASE = 'https://cabinet.example.com';

describe('письма', () => {
  it('ссылка на восстановление несёт токен и ведёт в кабинет', () => {
    const letter = passwordResetLetter(BASE, 'токен-123', 2);
    expect(letter.body).toContain('https://cabinet.example.com/reset-password?token=');
    expect(letter.body).toContain('2 ч');
    expect(letter.kind).toBe('password_reset');
  });

  it('адрес кабинета с косой чертой на конце не даёт двойной черты', () => {
    const letter = passwordResetLetter('https://cabinet.example.com/', 'токен', 2);
    expect(letter.body).not.toContain('com//');
  });

  it('токен уходит в письмо закодированным', () => {
    // Токен — base64url, но полагаться на это нельзя: письмо не должно ломаться
    // от символа, который в адресе значит другое.
    const letter = passwordResetLetter(BASE, 'a+b/c=', 2);
    expect(letter.body).toContain('token=a%2Bb%2Fc%3D');
  });

  it('подтверждение адреса честно говорит, что доступ открывает администратор', () => {
    // Иначе человек ждёт, что подтверждение письма пустит его в систему.
    expect(emailVerificationLetter(BASE, 'токен', 24).body).toContain('администратором');
  });

  it('письмо о занятом адресе не сообщает ничего лишнего', () => {
    // Оно уходит вместо ответа «адрес занят», и в нём не должно быть ни имени,
    // ни роли, ни токена — только повод восстановить пароль.
    const letter = registrationAttemptLetter(BASE);
    expect(letter.body).toContain('forgot-password');
    expect(letter.body).not.toContain('token');
  });
});
