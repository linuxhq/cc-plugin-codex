import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      eqeqeq: 'error',
      'no-var': 'error',
      'padding-line-between-statements': [
        'error',
        {
          blankLine: 'always',
          prev: ['if', 'for', 'while', 'do', 'switch', 'try', 'with'],
          next: '*',
        },
      ],
      'prefer-const': 'error',
      'max-len': ['error', { code: 80, tabWidth: 2 }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      complexity: ['error', 12],
      'max-depth': ['error', 3],
      'max-lines-per-function': [
        'error',
        { max: 65, skipBlankLines: true, skipComments: true },
      ],
    },
  },
  {
    files: ['tests/**'],
    rules: { 'max-lines-per-function': 'off' },
  },
];
