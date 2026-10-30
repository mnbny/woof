# Woof technical brief

## Execution model

Development uses TypeScript on Node.js 22.13+ (22.x), 24.x, or 26+, and pnpm 12.16.1. The Node.js range follows the combined ESLint and Vitest requirements. `cli/woof.mjs` registers tsx from this checkout, then loads `cli/cli.ts`. The caller does not need its own TypeScript loader or dependencies.

`pnpm build` bundles the CLI with esbuild and minifies it with terser. The generated `cli/woof.bundle.mjs` includes its JavaScript runtime dependencies and targets Node.js 20. The MAACS consumer baseline is Node.js 20.12 or later. The bundle is intended to be committed, and `.gitattributes` marks it as generated. Regenerate it instead of editing or merging it by hand.

## Organization

- `cli/cli.ts`: root command registration, metadata, and completion setup.
- `cli/commands/`: future product commands.
- `cli/utils/`: future shared utilities.
- `.tools/scripts/`: build and validation runner.
- `.tools/validators/`: future repository-specific validators.
- `.tools/tests/`: Vitest configuration, isolated subprocess fixtures, and tests.
- `.agents/docs/`: documentation registry and project briefs.
- `.vscode/`: shared editor settings and recommended extensions.

Commands own orchestration and reporting. A helper used by one command stays there. A shared utility needs a distinct shared responsibility.

## Dependencies and conventions

Dependencies started from the MAACS reference snapshot and are maintained independently. Versions are exact. The pnpm workspace configuration permits esbuild's installation script. Obsolete exceptions for Vitest 5.0.1 were removed when upgrading to 5.0.5.

TypeScript stays at 6.0.3 because typescript-eslint 8.72.1 requires TypeScript below 6.1.0; TypeScript 7 is not supported by that toolchain. Recheck this constraint when upgrading typescript-eslint.

eslint-plugin-import 2.32.0 is its latest release, but its declared ESLint peer range ends at version 9. The repository already used ESLint 10, and this peer warning remains with ESLint 10.13.0. Do not suppress the warning with a peer override; recheck upstream support on future upgrades.

- citty defines commands; `@bomb.sh/tab` provides completion.
- Clack, ansis, change-case, and yaml are available for future interaction, styling, naming, and parsing.
- tsx runs source; esbuild and terser produce the bundle.
- TypeScript extends `@tsconfig/strictest`, uses NodeNext modules, and permits explicit `.ts` imports.
- ESLint enforces the reference's TypeScript and import rules. Prettier uses single quotes, no semicolons, a 120-column print width, and unwrapped prose.
- Vitest runs tests separately from validation.

No application framework, release pipeline, CI workflow, or Git hooks have been added; the reference has none of these.

## Validation and tests

`pnpm validate` runs formatting, linting, type checking, then the build. Formatting and linting can rewrite files. The copied scripty runner discovers `validate:*` scripts and orders them by their `SCRIPTY` values. A failure stops subsequent steps, including bundle regeneration.

The reference's skill and prompt validators depend on MAACS product code and catalogs, so they are omitted. Add future validators under `.tools/validators/` and register them as ordered `validate:*` scripts.

`pnpm test` uses Vitest with two workers. Its configuration compiles the current CLI source for subprocess checks, so tests do not rely on a previously generated bundle. Fixtures isolate the working directory and home. Infrastructure smoke tests cover source execution from another directory and bundled execution without installed dependencies.

## Developer setup

VS Code uses ESLint fixes on save and Prettier for JSON, Markdown, shell scripts, and YAML. Paseo runs `asdf install`, `pnpm install`, and `node cli/setup.mjs --dev` in sequence. As in MAACS, no repository-local `.tool-versions` file is supplied; asdf uses the developer's inherited configuration.

`CLAUDE.md` points to `AGENTS.md`, and `.claude` points to `.agents`. No skills are vendored or linked into this project.
