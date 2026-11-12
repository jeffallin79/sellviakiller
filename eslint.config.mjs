// Repo ESLint (flat config). Slice-1 rule: apps may not hard-code colours — use
// @storeforge/ui role tokens (rgb(var(--sf-…))) instead. CSS files are covered by
// packages/ui/scripts/check-colors.mjs (run by each app's `lint`).
import tsParser from '@typescript-eslint/parser';

const HEX = String.raw`/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/`;
const FN = String.raw`/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\((?!\s*var\()/`;
const NAMED = String.raw`/^(?:white|black|red|green|blue|yellow|orange|purple|violet|pink|gray|grey|silver|navy|teal|maroon|olive|lime|aqua|fuchsia|indigo|crimson|gold)$/i`;
const msg = 'Raw colour in app code — use a @storeforge/ui token, e.g. rgb(var(--sf-brand)).';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${HEX}]`, message: msg },
        { selector: `TemplateElement[value.raw=${HEX}]`, message: msg },
        { selector: `Literal[value=${FN}]`, message: msg },
        { selector: `TemplateElement[value.raw=${FN}]`, message: msg },
        { selector: `Property[key.name=/^(color|background|backgroundColor|borderColor|fill|stroke|outlineColor)$/] > Literal[value=${NAMED}]`, message: msg },
      ],
    },
  },
];
