# CLI

## Entry points

`cli/cli.ts` defines the root command with package metadata. Product commands will be registered from `cli/commands/`. Currently, the only behavior is help, version information, and shell completion.

`cli/woof.mjs` runs source through the checkout's tsx installation. `cli/woof.bundle.mjs` is the generated, self-contained executable.

## Setup

`node cli/setup.mjs` links `~/.local/bin/woof` to the bundle. `node cli/setup.mjs --dev` links it to the source launcher. The link stays outside versioned Node installations. Setup skips linking in CI and refuses to replace an existing regular file.

Setup registers completion in `.zshrc` or `.bashrc` without duplicate registration. For zsh, registration requires `compdef` to be available. Fish and PowerShell users can register the output of `woof complete <shell>` themselves.

Setup changes the user's local executable link and shell configuration. Dependency installation does not run setup automatically.

## Completion

`@bomb.sh/tab` injects the `complete` subcommand. It stays available to shells and is hidden from normal help. Future product commands can add completion handlers as needed.
