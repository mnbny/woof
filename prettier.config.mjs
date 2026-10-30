export default {
  arrowParens: 'avoid',
  bracketSameLine: true,
  bracketSpacing: true,
  plugins: ['prettier-plugin-packagejson', 'prettier-plugin-sh'],
  printWidth: 120,
  // Prose stays on one line. Two adjacent lines are one paragraph, so meaning belongs in a list item or a new block.
  proseWrap: 'never',
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
}
