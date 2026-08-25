"use strict";
// Flat-config ESLint — correctness-focused, tuned to this codebase's existing
// style so it passes with zero churn. Formatting is NOT linted (that's a
// Prettier concern, if ever wanted); these rules hunt bugs and drift:
//   * js.configs.recommended      — no-undef, no-unused-vars, no-implicit-globals…
//                                   (a missing require() blows up here first)
//   * prefer-const / no-var       — the codebase is already const-only
//   * eqeqeq {null:'ignore'}      — `x == null` is deliberate idiom here
//   * no-empty {allowEmptyCatch}  — `catch (_) {}` swallow-guards are intentional
//   * _-prefixed args ignored     — matches the `_key`, `_id` placeholder habit
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["coverage/", "node_modules/"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
];
