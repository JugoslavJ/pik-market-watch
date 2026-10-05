"use strict";
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  {
    ignores: ["coverage/", "node_modules/"],
  },
  {
    files: ["**/*.js", "**/*.cjs"],
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
  {
    files: ["dashboard-viewer/src/*.js", "dashboard-viewer/vite.config.js"],
    languageOptions: { sourceType: "module" },
  },
  {
    files: [
      "dashboard-viewer/src/*.js",
      "dashboard-viewer/tests/*.cjs",
      "superset/tests/*.cjs",
      "superset/dashboard_requests.js",
    ],
    languageOptions: { globals: globals.browser },
  },
];
