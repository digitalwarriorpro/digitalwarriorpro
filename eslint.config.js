import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{js,ts}"],
    languageOptions: {
      globals: globals.node,
      sourceType: "module",
      ecmaVersion: "latest",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
  prettier,
  {
    ignores: ["dist/", "node_modules/"],
  },
];
