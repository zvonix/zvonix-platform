// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Файлы настроек инструментов не входят в типизированный проект (tsconfig указывает
  // только на src), поэтому проверка с типами на них не работает. Их корректность
  // проверяется запуском самих инструментов: drizzle.config.ts — командой db:generate в CI.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.config.js', '**/*.config.ts'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ADR-0008, ADR-0010: деньги — только BigInt в микроединицах.
      // number в денежных вычислениях запрещён, поэтому запрещаем и неявные
      // преобразования BigInt, через которые точность теряется молча.
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      // Подчёркивание в начале имени — принятый способ сказать «значение не нужно».
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Модуль NestJS — пустой класс с декоратором: он и есть единица сборки,
    // а тела у него быть не должно. Правило про «класс без членов» здесь
    // требовало бы писать бессмысленный код ради его удовлетворения.
    files: ['**/*.module.ts'],
    rules: { '@typescript-eslint/no-extraneous-class': 'off' },
  },
  {
    // Тесты: в них допустимы утверждения о типах, которых нет в рантайме.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
