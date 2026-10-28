// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// An allow-list: packages, Node built-ins and anything reached through node_modules are all outside the business rules.
const relativeImportsOnly = {
  regex: String.raw`^(?!\.{1,2}/)|(^|/)node_modules(/|$)`,
  message: 'Business rules may only import relative modules. Reach frameworks, Node APIs and I/O through a port.',
};

const outerSharedLayers = {
  regex: '(^|/)shared/(http|config|logging|resilience)(/|$)',
  message: 'Dependencies must point inward: shared HTTP, config, logging and resilience are outer layers.',
};

const outerFeatureLayers = {
  regex: '(^|/)(infrastructure|presentation)(/|$)',
  message: 'Dependencies must point inward: infrastructure and presentation are outer layers.',
};

const PROCESS_MESSAGE = 'Business rules must not read environment variables or process state.';

const noProcessGlobal = ['error', { name: 'process', message: PROCESS_MESSAGE }];

const noProcessThroughGlobalObject = [
  'error',
  { object: 'globalThis', property: 'process', message: PROCESS_MESSAGE },
  { object: 'global', property: 'process', message: PROCESS_MESSAGE },
];

const redactedTextAssertions = [
  ...['TSAsExpression', 'TSTypeAssertion'].map((assertion) => ({
    selector: `${assertion}[typeAnnotation.typeName.name='RedactedText']`,
    message: 'Only the sanitizer may create RedactedText. Sanitize the message instead of casting.',
  })),
  {
    selector: "CallExpression > TSTypeParameterInstantiation > TSTypeReference[typeName.name='RedactedText']",
    message: 'Only the sanitizer may create RedactedText. Do not pass it as an explicit type argument.',
  },
];

const noDynamicImports = {
  selector: 'ImportExpression',
  message: 'Business rules must not load modules dynamically; dynamic imports bypass the import allow-list.',
};

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
            relativeImportsOnly,
            outerSharedLayers,
            {
              regex: '(^|/)(application|infrastructure|presentation)(/|$)',
              message: 'The domain depends on nothing but itself and the shared kernel.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/secure-inquiry/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [relativeImportsOnly, outerSharedLayers, outerFeatureLayers] }],
    },
  },
  {
    // The sanitizer is the only producer of RedactedText; anywhere else a cast would smuggle raw input past the brand.
    files: ['src/**/*.ts'],
    ignores: ['src/secure-inquiry/domain/sanitization/**'],
    rules: {
      'no-restricted-syntax': ['error', ...redactedTextAssertions],
    },
  },
  // Flat config replaces rule options instead of merging them, so these two blocks must follow the one above.
  {
    files: ['src/secure-inquiry/domain/**/*.ts', 'src/secure-inquiry/application/**/*.ts'],
    rules: {
      'no-restricted-globals': noProcessGlobal,
      'no-restricted-properties': noProcessThroughGlobalObject,
      'no-restricted-syntax': ['error', noDynamicImports, ...redactedTextAssertions],
    },
  },
  {
    files: ['src/secure-inquiry/domain/sanitization/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', noDynamicImports],
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
