# CLI

## Purpose and ownership

The CLI owns argument parsing, startup order, command dispatch, and shared presentation. Each command owns its operation, recovery, and exit status. Configuration, projects, tokens, scripts, sharing, and agent mode each have a brief.

## Commands

The commands are readme, init, add, edit, get, tree, projects, explain, validate, export, and import. Command briefs describe individual operations. The configuration brief owns structure views.

Global flags select agent mode, request explicit migration, and show help or the version. Commands that need a project context accept an option that selects a registered project. A qualified token address that names a project has the same effect as that option. If the address and the option select different projects, the command fails. Tree paths are relative to the selected scope instead.

## Invocation and startup

Before startup, woof checks the command name, the argument counts, the required options, and contradictory selectors. The migration flag can appear anywhere before the argument terminator. Startup reads the migration flag for every command. The commands do not read the flag.

After these checks, startup checks the configuration and applies an explicit migration. The configuration brief describes these steps.

- Help and version are passive. They do not create woof home.
- Unless migration is requested, readme skips all configuration checks. This keeps the guide readable when the configuration is broken.
- An invalid invocation fails before woof creates its home or runs a migration.

## Presentation and exit status

- Human mode uses Clack for results, interactive choices, and import review. Human presentation assumes a terminal with color and follows these conventions:
  - Each choice has a label and a muted hint. For a scope, the hint gives the path that the choice stands for on this machine. For an action, the hint says in plain words what the action does. A hint gives information, not a status. In an action picker, the most common action comes first, so it is the default.
  - The choices fit the context. If woof detects a project, the choices are the shared tokens and that project. If not, the choices are all registered projects, or the matching projects if several match.
  - A text question or a picker is a short noun, such as "Token to get" or "Project to use". A text question can have a muted note, such as an example or "optional".
  - Get, edit, and explain open the token search picker for a missing or inexact address. Validate opens it for an inexact address. A supplied address becomes the search. A missing project opens a project picker.
  - Tree offers a full view or a project view. The project view uses the detected project, or a project picker. Explicit paths and scopes skip the picker. Tree has no namespace picker.
  - In a terminal with color, tree keys and connectors share a color for each nesting level. Vertical guides keep their ancestor level's color. The colors repeat at deeper levels. Markers keep their default color. Agent output has no color.
  - Token paths, project names, file paths in errors, example values, flags, and commands show as inline code in questions, errors, summaries, and follow-up hints.
  - A token list marks the scope of each token with a badge: global for a shared token, project for a token of the selected project. A script token also has a badge with its runtime. Badge colors come from the 256-color palette, so every color terminal shows them the same.
  - Result details are fields. Their values align in one column and are muted.
  - The selected project shows with the reason for the selection, such as the repository configuration or a path match. A repository project takes the name of its checkout folder.
  - A field with several paths lists one path per line. Its label is singular for one path. When the field has no path, woof leaves it out. For agents, the values of a field stay on one line.
  - A success message reports a change. An outcome that changes nothing, such as a cancellation, is a warning.
  - Errors say plainly what is wrong and which token or file is at fault. An error or a handoff does not add that nothing changed.
  - A code block has a guide line above it and padding on all sides.
- Agent mode prints only text from markdown templates. The command supplies the values in the template, such as names, paths, candidate lists, diffs, and error details. Each agent message, warning, and notice has its own template. Agents get the same choices and labels as people, with each path after its label. Agent text has no styles and no alignment. An agent list puts each item on its own bulleted line. A command that applies to all items follows the list once. Templates do not repeat the guidance of the execution skill.
- Payloads, results, and reports go to standard output. Warnings, migration notices, the execution skill recommendation, and script error output go to standard error.
- A failure exits with status 1. An interactive cancellation exits with status 130.
- If a human has no terminal, woof returns the agent handoff and exits with status 1. woof does not report a cancellation in this case.

## Distribution

Source execution, standalone execution, and package execution have the same behavior. woof is published on npm under the mnbny scope. Users run the package through npx, without an installation. Command recommendations pin an exact package version. Installed skills keep their pin until the user chooses to update it.

The package contains the standalone bundle, the agent templates, the edit page, the readme, the license, and the execution skill. Nothing else ships. The pack step builds the bundle. Before a release, a pack check builds the package and compares its contents with the files that woof reads at runtime. The pack check then runs the package through npx with an empty home. Tokens in the repository configuration hold the version preparation and release procedures. Version preparation keeps the package version and command pins in sync.

A link script in the repository puts the source entry on the user's local path.
