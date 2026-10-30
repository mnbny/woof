# Woof

CLI scaffold based on the tooling and development setup in `~/Dev/maacs`. Product commands have not been defined.

## Development

Use Node.js 22.13+ (22.x), 24.x, or 26+, and pnpm 12.16.1.

```sh
pnpm install --frozen-lockfile
node cli/woof.mjs --help
```

To make `woof` available in your shell:

```sh
node cli/setup.mjs --dev
```

This links `~/.local/bin/woof` to the source launcher and registers completion in `.zshrc` or `.bashrc`. Ensure `~/.local/bin` is on your `PATH`. Source changes take effect immediately.

## Commands

| Command                           | Purpose                                               |
| --------------------------------- | ----------------------------------------------------- |
| `pnpm build`                      | Bundle and minify the CLI into `cli/woof.bundle.mjs`. |
| `pnpm validate`                   | Format, lint, typecheck, and build, in order.         |
| `pnpm validate:format`            | Apply Prettier formatting.                            |
| `pnpm validate:lint`              | Apply ESLint fixes.                                   |
| `pnpm validate:typecheck`         | Run strict TypeScript checking.                       |
| `pnpm test`                       | Run Vitest separately from validation.                |
| `node cli/woof.mjs --help`        | Run the source CLI.                                   |
| `node cli/woof.bundle.mjs --help` | Run the self-contained bundle.                        |

Validation formats and fixes files. A failed step stops the remaining steps. Tests compile the current CLI source and check that source and bundled execution work from outside the repository.

## Distribution

The generated bundle is intended to be committed, matching MAACS. Regenerate it with `pnpm build`; do not edit it by hand. Consumers need Node.js 20.12 or later and can run the bundle without installing dependencies.

```sh
node cli/setup.mjs
woof --help
```

## Structure

```text
.agents/docs/       Agent documentation registry and briefs
.claude            Symlink to .agents
.tools/
  scripts/         Build and ordered validation runner
  tests/           Vitest configuration, fixtures, and smoke tests
  validators/      Space for future project validators
.vscode/           Shared settings and extensions
cli/
  cli.ts           Root command and shell completion
  commands/        Future product commands
  utils/           Future shared utilities
  setup.mjs        Local executable and completion setup
  woof.mjs         TypeScript source launcher
  woof.bundle.mjs  Generated standalone executable
AGENTS.md          Agent entry point
CLAUDE.md          Symlink to AGENTS.md
paseo.json         Workspace setup and commit guidance
```

The TypeScript, ESLint, Prettier, build, validation, editor, and CLI launch/setup patterns come from MAACS. Dependency versions and the lockfile are maintained independently. Paseo's setup command runs sequentially so dependencies are installed before source setup.

MAACS product commands, utilities, catalogs, resource validators, and product tests are excluded. No project-local skills are copied. Agent instructions refer to globally installed skills.
