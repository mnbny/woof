# CLI

## Purpose and ownership

The CLI owns argument parsing, startup order, command dispatch, and shared presentation. Each command owns its operation, recovery, and exit status. Configuration, projects, tokens, scripts, sharing, and agent mode each have a brief.

## Commands

The commands are readme, init, get, projects, explain, validate, export, and import. Each command has a brief.

Global flags select agent mode, request explicit migration, and show help or the version. Commands that need a project context accept an option that selects a registered project. A qualified address that names a project has the same effect as that option. If the address and the option select different projects, the command fails.

## Invocation and startup

Before startup, Woof checks the command name, the argument counts, the required options, and contradictory selectors. The migration flag can appear anywhere before the argument terminator. Startup reads the migration flag for every command. The commands do not read the flag.

After these checks, startup checks the configuration and applies an explicit migration. The configuration brief describes these steps.

- Help and version are passive. They do not create Woof home.
- Unless migration is requested, readme skips all configuration checks. This keeps the guide readable when the configuration is broken.
- An invalid invocation fails before Woof creates its home or runs a migration.

## Presentation and exit status

- Human mode uses Clack for results, interactive choices, and import review.
- Agent mode prints only text from markdown templates. The command supplies the values in the template, such as names, paths, candidate lists, diffs, and error details. Each agent message, warning, and notice has its own template.
- Payloads, results, and reports go to standard output. Warnings, migration notices, the execution skill recommendation, and script error output go to standard error.
- A failure exits with status 1. An interactive cancellation exits with status 130.
- If a human has no terminal, Woof returns the agent handoff and exits with status 1. Woof does not report a cancellation in this case.

## Distribution

Source execution, standalone execution, and local package execution have the same behavior. The package contains the standalone bundle and the execution skill. The pack step builds the bundle. A link script in the repository puts the source entry on the user's local path.
