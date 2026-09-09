/**
 * The rules this repository already had, made enforceable.
 *
 * docs/ENGINEERING.md has said for a long time: no `any`, no empty `catch {}`
 * without a comment explaining the deliberate swallow, no `console.log` outside
 * the logger, `import type` for type-only imports. They were conventions, which
 * means they held exactly as well as whoever was reading the diff.
 *
 * What made this urgent is a rule nobody had written down at all.
 * `react-hooks/rules-of-hooks` exists to catch a hook below an early return,
 * and a hook below an early return is not a lint nit here -- React answers it
 * by throwing during render and unmounting the tree, so it is a blank screen.
 * One reached a published release. TypeScript cannot see hook order, no test
 * rendered a page, and there was no ESLint in this repository, so the one tool
 * built for it had never run.
 *
 * Deliberately not type-aware. A type-aware config needs a program per file and
 * turns a two-second check into a minute, and everything below is answerable
 * from the syntax. `npm run typecheck` already owns the type questions.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    // Generated, vendored, or not ours. `../ai4cz` is immutable evidence and is
    // not in this tree, but build output and coverage very much are.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'build/**',
      'coverage/**',
      '**/.vite/**',
      'test-results/**',
      'playwright-report/**',
      'storage/**',
      // Runtime scratch, gitignored alongside storage/. Linting throwaway
      // diagnostic scripts held here produces failures that mean nothing and
      // hide the ones that do.
      'var/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // -- The conventions, verbatim from docs/ENGINEERING.md -----------------

      // "No `any`". A warning rather than an error only where it is unavoidable
      // below; everywhere else it is a mistake.
      '@typescript-eslint/no-explicit-any': 'error',

      // "no empty `catch {}` without a comment explaining the deliberate
      // swallow". ESLint cannot read the comment, but it can insist there is
      // something in the block -- and this codebase's swallows all carry one.
      'no-empty': ['error', { allowEmptyCatch: false }],

      // "no `console.log` outside the logger". warn and error stay: they are
      // how a script with no logger reports a failure, and how the error
      // boundary records the one stack that cannot be recovered otherwise.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // "`verbatimModuleSyntax` is on: use `import type` for type-only
      // imports." The compiler enforces this at the point of use; this makes
      // the whole import statement consistent rather than mixed.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          // `let pdfjs: typeof import('pdfjs-dist/...')` is how a module that
          // is *deliberately* not imported statically gets a type. Optional
          // dependencies are loaded in a try/catch here and the annotation is
          // the only way to say what they are; forbidding it would require a
          // static import of the one thing that must not have one.
          disallowTypeAnnotations: false,
        },
      ],

      // -- Things that are bugs rather than style ----------------------------

      // `if (x = 1)`. The default -- `except-parens` -- still allows the one
      // form that is always deliberate: `while ((m = re.exec(s)) !== null)`,
      // which is how you walk every match of a sticky regex.
      'no-cond-assign': ['error', 'except-parens'],
      // A `case` that falls into the next one is almost never meant.
      'no-fallthrough': 'error',
      // An await inside a loop is usually deliberate here (leases, migrations,
      // anything that must be serial), so that is not policed. A floating
      // promise is a different matter, but catching it needs type information.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        // A leading underscore is the established way of saying "required by
        // the signature, deliberately unused".
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // -- The web application -----------------------------------------------------
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // The rule this whole file exists for. Never a warning: a hook below an
      // early return is a black screen, and a warning is something a build
      // prints and nobody reads.
      'react-hooks/rules-of-hooks': 'error',
      // Dependencies are a warning, honestly. Some of the polling here is
      // deliberately not re-subscribed on every change, and turning those into
      // errors would mean disabling the rule in the places it matters most.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // -- Scripts and tooling -----------------------------------------------------
  {
    files: ['tools/**/*.{js,mjs,ts,mts}', 'scripts/**/*.{js,mjs,ts,mts}'],
    rules: {
      // These are command-line tools. Their entire user interface is stdout,
      // and routing it through the application logger would put a JSON line
      // where a person expects a sentence.
      'no-console': 'off',
    },
  },

  // -- Code that runs inside a browser page ------------------------------------
  {
    // The body of a `page.evaluate`, which is shipped to Chromium and runs
    // there. It is written in this file and executed in another world, so the
    // globals it may use are the browser's, not Node's.
    files: ['tools/shots/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },

  // -- Tests -------------------------------------------------------------------
  {
    files: ['tests/**/*.{ts,tsx,mts}'],
    rules: {
      // A test that proves a bad shape is rejected has to be able to build one.
      '@typescript-eslint/no-explicit-any': 'off',
      // `expect(x!).toBe(...)` on a row a query just returned is clearer than
      // an assertion dance around a value the test already knows exists.
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
);
