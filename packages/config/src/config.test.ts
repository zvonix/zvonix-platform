import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_VARIABLES,
  ConfigError,
  isSecretVariable,
  loadConfig,
  PUBLIC_VARIABLE_NAMES,
  redactSecrets,
  SECRET_VARIABLE_NAMES,
} from './config.js';

const VALID_SECRET = 'x'.repeat(32);

function validEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/zvonix',
    SECRET_KEY: VALID_SECRET,
    ...overrides,
  };
}

describe('загрузка конфигурации', () => {
  it('подставляет значения по умолчанию', () => {
    const config = loadConfig(validEnv());
    expect(config.APP_ENV).toBe('development');
    expect(config.APP_NAME).toBe('zvonix');
    expect(config.APP_PORT).toBe(8000);
    expect(config.LOG_LEVEL).toBe('info');
  });

  it('приводит порт из строки к целому числу', () => {
    expect(loadConfig(validEnv({ APP_PORT: '3000' })).APP_PORT).toBe(3000);
  });

  it('возвращает неизменяемый объект', () => {
    const config = loadConfig(validEnv());
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe('проверка при старте', () => {
  it('перечисляет все проблемы сразу, а не первую', () => {
    let error: unknown;
    try {
      loadConfig({ APP_PORT: 'не число', LOG_LEVEL: 'подробно' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    const mentioned = problems.map((problem) => problem.split(':')[0]);
    // Четыре независимые проблемы: две неверные и две отсутствующие переменные.
    expect(mentioned).toContain('APP_PORT');
    expect(mentioned).toContain('LOG_LEVEL');
    expect(mentioned).toContain('DATABASE_URL');
    expect(mentioned).toContain('SECRET_KEY');
  });

  it('отдельно отмечает незаданные переменные', () => {
    let error: ConfigError | undefined;
    try {
      loadConfig({ SECRET_KEY: VALID_SECRET });
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error?.problems).toContain('DATABASE_URL: значение не прошло проверку');
  });

  it('отвергает строку подключения не к PostgreSQL', () => {
    expect(() => loadConfig(validEnv({ DATABASE_URL: 'mysql://localhost/zvonix' }))).toThrow(
      ConfigError,
    );
  });

  it('отвергает короткий секретный ключ', () => {
    expect(() => loadConfig(validEnv({ SECRET_KEY: 'коротко' }))).toThrow(ConfigError);
  });
});

describe('защита секретов', () => {
  it('не печатает значение секрета в тексте ошибки', () => {
    let error: ConfigError | undefined;
    try {
      loadConfig(validEnv({ SECRET_KEY: 'СЕКРЕТНОЕ-ЗНАЧЕНИЕ' }));
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error).toBeDefined();
    expect(error?.message).not.toContain('СЕКРЕТНОЕ-ЗНАЧЕНИЕ');
    expect(JSON.stringify(error?.problems)).not.toContain('СЕКРЕТНОЕ-ЗНАЧЕНИЕ');
  });

  it('не печатает пароль из строки подключения', () => {
    let error: ConfigError | undefined;
    try {
      loadConfig(validEnv({ DATABASE_URL: 'mysql://user:ПАРОЛЬ@host/db' }));
    } catch (caught) {
      error = caught as ConfigError;
    }
    expect(error?.message).not.toContain('ПАРОЛЬ');
  });

  it('скрывает секреты при выводе конфигурации', () => {
    const redacted = redactSecrets(loadConfig(validEnv()));
    expect(redacted['DATABASE_URL']).toBe('<скрыто>');
    expect(redacted['SECRET_KEY']).toBe('<скрыто>');
    expect(redacted['APP_NAME']).toBe('zvonix');
    expect(JSON.stringify(redacted)).not.toContain('pass');
  });

  it('знает, какие переменные секретны', () => {
    expect(isSecretVariable('SECRET_KEY')).toBe(true);
    expect(isSecretVariable('DATABASE_URL')).toBe(true);
    expect(isSecretVariable('APP_PORT')).toBe(false);
  });
});

describe('классификация переменных', () => {
  // Без этой проверки новая переменная с паролем молча считается несекретной,
  // и её значение попадает в лог при первой же ошибке конфигурации.
  it('каждая переменная схемы отнесена ровно к одному классу', () => {
    const classified = [...SECRET_VARIABLE_NAMES, ...PUBLIC_VARIABLE_NAMES].sort();
    expect(classified).toEqual([...CONFIG_VARIABLES]);
  });

  it('классы не пересекаются', () => {
    const overlap = SECRET_VARIABLE_NAMES.filter((name) => PUBLIC_VARIABLE_NAMES.includes(name));
    expect(overlap).toEqual([]);
  });
});

describe('синхронизация с .env.example', () => {
  // ADR-0002: переменная добавляется одновременно в схему и в .env.example.
  // Этот тест делает правило проверяемым машиной, а не соглашением.
  it('в .env.example описаны ровно те переменные, что читает приложение', () => {
    const path = fileURLToPath(new URL('../../../.env.example', import.meta.url));
    const documented = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();

    expect(documented).toEqual([...CONFIG_VARIABLES]);
  });
});
