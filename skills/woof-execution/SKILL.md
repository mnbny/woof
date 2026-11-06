---
name: woof-execution
description: Use woof to find tokens, follow reusable prompts, run computed resources, and add, edit, or share tokens. Use when the user mentions woof or asks to use a woof convention, find a token for a task, save or change a token, set up woof for a repository, or export or import a woof project.
metadata:
  version: 14
---

# woof execution

woof is a local CLI for reusable prompts and scripts. It stores each resource as a token with a dotted path, such as `conventions.commit`. A prompt is text. A script runs in bash, node, tsx, or bun; its output becomes the token's value. Tokens combine instructions through `{{path}}` references.

Every project can use or override shared tokens in woof home. A project is registered by name in woof home or defined by a repository configuration. Run `woof` from the user's target project. The current directory selects the project.

## Choose the command

Keep the user's task, scope, and constraints. Select the command below. Try the CLI before you investigate its installation or source.

| Command      | Purpose                                                               |
| ------------ | --------------------------------------------------------------------- |
| `get`        | Find tokens, or resolve a token to its payload.                       |
| `tree`       | Show configuration structure without token content.                   |
| `add`        | Add a token.                                                          |
| `edit`       | Change the content, description, or tags of a token.                  |
| `projects`   | List registered projects and show what the current directory selects. |
| `init`       | Create a project configuration.                                       |
| `explain`    | Show how a token resolves, without running scripts.                   |
| `validate`   | Check the configuration, without running scripts.                     |
| `export`     | Package a registered project as an archive.                           |
| `import`     | Review an archive and apply it.                                       |
| `readme`     | Print the user guide.                                                 |
| `secret KEY` | Read one local secret inside shell command substitution.              |

For a request to use a resource or task, follow **Use a token**. For example, "use woof's commit convention" means `woof get 'commit convention' --agent`.

Use `npx --yes @mnbny/woof@0.1.7` wherever this skill or CLI output shows `woof`. Keep this pin until the user asks to change it.

Pass `--agent` to every command: `npx --yes @mnbny/woof@0.1.7 <command> --agent`.

Shell-quote token addresses and search terms as data.

Read and follow the output, including after a nonzero exit. A handoff makes no changes and exits with status 1. It names the missing decision and gives the next command. Report unresolved failures.

Reuse explicit user choices. Agent mode grants no additional permission. Save, change, import, or restore only after the user approves. Do not install other packages to guess a remedy.

Report migrations that change a repository configuration. Git shares that file, so checkout users need a woof release that supports the new schema version.

Use `--help` or `woof readme --agent` only when the request, the output, or the recovery is unclear.

## Find tokens

For discovery requests, such as "what does woof have for commits?", search without resolving a token:

```sh
woof get '<terms>' --search --agent
```

To list every token in the selected project, omit the terms. Report matching paths, kinds, and descriptions, or state that none match. Resolve a token only when the user asks to use it.

## Use a token

To use a token, pass its exact address. If the user gives no address, pass a short task description.

```sh
woof get '<address-or-terms>' --agent
```

1. If `get` returns a payload, follow prompt content as instructions for the user's original request. Do not run `get` again to show or submit the result.
2. If `get` returns candidates, retrieve the clear match with the command provided. If several fit, show their paths and descriptions, then ask the user to choose. If none fit, report that result.
3. If several projects match, retry with the project the user named. Otherwise, ask the user to choose.

If a payload names another token to use, retrieve its exact address when that instruction applies.

`get` runs expanded scripts in the selected project's checkout. woof does not undo script effects. Candidate kinds identify scripts. If a token can reach a script the user did not ask to run, inspect it with `woof explain` first.

### Secrets

Reference checks require nonempty values for declared secrets. `get` supplies secrets to script tokens. For commands described by prompts, prepend the supplied environment assignments, such as `ENV_NAME="$(woof secret 'secret.key')"`. The command must read its environment.

Use `secret` only inside command substitution. Keep shell tracing off. Secret lookup returns raw values in human and agent modes; failures produce no stdout. Never open or display `woof.secrets.json` or print secret values. If a value is missing, ask the user to fill it in locally, then retry. Do not ask for values in the conversation.

## Change the catalog

Run the command for the change and follow its drafting steps. Show the result to the user before the final command.

- To add a token, run `woof add --agent`.
- To change a token, run `woof edit '<address>' --agent`.
- To create a project configuration, run `woof init --agent`.

In prompt content, `{{path}}` inserts a token's content. `{{~path~}}` produces an instruction to use that token later, without loading or running it. Write `{{{{` and `}}}}` for literal double braces.

Declare secret bindings with repeatable `--secret ENV_NAME=secret.key` flags on add or edit. Supply names only, never values. On edit, the flag replaces all bindings; `--secret ''` removes them. Omit the flag to preserve them.

woof cannot rename, move, retype, or remove a token. For these changes, edit the configuration file that `woof explain` reports. Then run `woof validate --agent`.

## Share a project

To share a registered project, run `woof export --project '<name>' --agent`. To receive a project, run `woof import '<archive>' --agent`.

Import adds new items automatically. Each item that exists on both sides and differs requires a user decision. Record only decisions the user made. Import saves secret bindings and reports missing local values during post-import validation.

## Inspect the structure

When the user wants to see the configuration structure, use `woof tree --agent`. An optional path narrows the view, such as `woof tree 'git' --agent`. Use `--project '<name>'` or `--repo` for project definitions only.
