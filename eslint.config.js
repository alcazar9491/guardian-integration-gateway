// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

const frameworkImports = [
  {
    regex: '^(express|pino|zod)(/.*)?$',
    message: 'Business rules must not depend on frameworks or libraries.',
  },
  {
    regex: '^(node:)?(fs|path|crypto)(/.*)?$',
    message: 'Business rules must not depend on filesystem or crypto APIs. Define a port instead.',
  },
];

const outerSharedLayers = {
  regex: '(^|/)shared/(http|config|logging|resilience)(/|$)',
  message: 'Dependencies must point inward: shared HTTP, config, logging and resilience are outer layers.',
};

const outerFeatureLayers = {
  regex: '(^|/)(infrastructure|presentation)(/|$)',
  message: 'Dependencies must point inward: infrastructure and presentation are outer layers.',
};

const noProcessGlobal = [
  'error',
  { name: 'process', message: 'Business rules must not read environment variables or process state.' },
];

export default defineConfig(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['src/secure-inquiry/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...frameworkImports,
            outerSharedLayers,
            {
              regex: '(^|/)(application|infrastructure|presentation)(/|$)',
              message: 'The domain depends on nothing but itself and the shared kernel.',
            },
          ],
        },
      ],
      'no-restricted-globals': noProcessGlobal,
    },
  },
  {
    files: ['src/secure-inquiry/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...frameworkImports, outerSharedLayers, outerFeatureLayers] }],
      'no-restricted-globals': noProcessGlobal,
    },
  },
  {
    // The sanitizer is the only producer of RedactedText; anywhere else a cast would smuggle raw input past the brand.
    files: ['src/**/*.ts'],
    ignores: ['src/secure-inquiry/domain/sanitization/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...['TSAsExpression', 'TSTypeAssertion'].map((assertion) => ({
          selector: `${assertion}[typeAnnotation.typeName.name='RedactedText']`,
          message: 'Only the sanitizer may create RedactedText. Sanitize the message instead of casting.',
        })),
        {
          selector: "CallExpression > TSTypeParameterInstantiation > TSTypeReference[typeName.name='RedactedText']",
          message: 'Only the sanitizer may create RedactedText. Do not pass it as an explicit type argument.',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
