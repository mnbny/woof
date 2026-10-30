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
| `woof customize`                  | Create or locate personal configuration.              |
| `woof customize --show`           | Display saved configuration.                          |
| `woof upgrade`                    | Fast-forward the checkout that supplies this CLI.     |
| `woof upgrade --stash`            | Preserve local work while upgrading, then restore it. |

Validation formats and fixes files. A failed step stops the remaining steps. Tests compile the current CLI source and check launchers, configuration preservation, and upgrade recovery using isolated homes and local Git repositories.

## Configuration and updates

`woof customize` creates `~/.woof/woof.config.json` only if absent and prints its location. Set `WOOF_HOME` to use another state directory. The configuration starts with `schemaVersion: 1`; product settings have not been defined. Existing files stay unchanged. `--show` displays saved JSON. The command prints editor commands without opening an editor.

`woof upgrade` updates the checkout that contains the running CLI, regardless of the caller's directory. It requires a branch with a configured upstream and only permits fast-forward updates. Local changes block an incoming update unless `--stash` is supplied. Restoration preserves staged state and untracked files; conflicts retain a recovery stash and report the remaining work. Source execution refreshes changed dependencies after a successful upgrade.

Customize and Upgrade remain available when configuration needs repair.

## Agent mode

Pass `--agent` after a command to request plain, noninteractive output:

```sh
woof customize --agent --show
woof upgrade --agent
```

Woof also detects execution markers from Claude Code, Codex, Antigravity CLI, Gemini CLI, Cursor, GitHub Copilot CLI, OpenCode, Cline, pi, Roo Code, Kiro, and Devin CLI. Generic agent markers are supported. Installing an agent or configuring its credentials does not enable agent mode.

Explicit and detected agent mode use the same command operations. Help and errors remain plain even when color is forced or a terminal is available. Human output retains its terminal presentation. Agent mode never grants permission to stash changes; an upgrade still needs explicit stash authorization.

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
  cli.ts           Agent-aware startup
  main.ts          Root command and shell completion
  commands/        Customization and checkout upgrades
  utils/           Configuration, paths, and terminal output
  setup.mjs        Local executable and completion setup
  woof.mjs         TypeScript source launcher
  woof.bundle.mjs  Generated standalone executable
AGENTS.md          Agent entry point
CLAUDE.md          Symlink to AGENTS.md
paseo.json         Workspace setup and commit guidance
```

The TypeScript, ESLint, Prettier, build, validation, editor, and CLI launch/setup patterns come from MAACS. Dependency versions and the lockfile are maintained independently. Paseo's setup command runs sequentially so dependencies are installed before source setup.

Customize and Upgrade are adapted from MAACS. Its catalogs, resource validators, and unrelated commands are excluded. No project-local skills are copied. Agent instructions refer to globally installed skills.
