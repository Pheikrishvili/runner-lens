// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Generated output and JS tool configs — never linted.
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.config.js'],
  },
  js.configs.recommended,
  {
    // Type-aware linting, scoped to the files the tsconfig knows about.
    files: ['src/**/*.ts', '__tests__/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Empty catch blocks are the house style for best-effort telemetry:
      // every failure path here is deliberately swallowed so monitoring can
      // never fail the user's workflow. Each one carries a comment saying why.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests mock Node internals and need `require`/`any` to do it.
    files: ['__tests__/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
