---
name: woof-execution
description: Use woof, a local CLI for reusable prompts and computed resources, in the current conversation. Find tokens, retrieve and follow prompts, run computed resources, and add, edit, or share tokens. Use when the user mentions woof, says "woof get X", "use the woof token for X", "what does woof have for X", "save this to woof", "change the woof token X", or "set up woof for this repo", or asks to share, export, or import a woof project.
metadata:
  version: 10
---

# woof execution

woof is a local CLI that keeps reusable instructions and scripts in one catalog. woof stores each item as a token with a dotted path, such as `conventions.commit`. A token holds a prompt, which is text, or a script. A script runs in bash, node, tsx, or bun, and its output becomes the value of the token. A token can reference other tokens with `{{path}}`. One token can combine other tokens into larger instructions.

Shared tokens are in woof home, and every project can use them. A project overrides shared tokens. A project has a name in the woof home registry, or a configuration file in a repository defines the project. The current directory selects the project. Run `woof` from the user's target project.

## Choose the command

Keep the user's task, scope, and constraints. When the request is clear, use the command from the table. Try the CLI before you investigate its installation or source.

| Command    | Purpose                                                               |
| ---------- | --------------------------------------------------------------------- |
| `get`      | Find tokens, or resolve a token to its payload.                       |
| `tree`     | Show configuration structure without token content.                   |
| `add`      | Add a token, such as a convention from the conversation.              |
| `edit`     | Change the content, description, or tags of a token.                  |
| `projects` | List registered projects and show what the current directory selects. |
| `init`     | Create a project configuration.                                       |
| `explain`  | Show how a token resolves, without running scripts.                   |
| `validate` | Check the configuration, without running scripts.                     |
| `export`   | Package a registered project as an archive.                           |
| `import`   | Review an archive and apply it.                                       |
| `readme`   | Print the user guide.                                                 |

For a request to use a name or task outside this list, follow **Use a token**. The user does not need to say "token". For example, "use woof's commit convention" means `woof get 'commit convention' --agent`.

Run woof as `woof` when it's on the PATH. Otherwise, run `npx @mnbny/woof`, which fetches the package. This skill writes `woof` for both.

Pass `--agent` to every command: `woof <command> --agent`.

Read the output, also after a nonzero exit. A handoff writes nothing and exits with status 1. The handoff gives the decision and the exact next command. Follow the instructions in the output.

Reuse explicit user choices. Agent mode grants no additional permission. Save, change, import, or restore only after the user approves. If neither form runs, report it. Report an unresolved failure. Do not install other packages to guess a remedy.

When a migration changes a repository configuration, tell the user. Git shares that file, so each user of the checkout then needs a woof release that supports the new schema version.

Use `--help` or `woof readme --agent` only when the request, the output, or the recovery is unclear.

## Find tokens

Use this command for a discovery request, such as "what does woof have for commits?". The search does not resolve a token:

```sh
woof get '<terms>' --search --agent
```

To list every token in the selected project, omit the terms. Shell-quote terms as data. Report the matches with their paths, kinds, and descriptions. If no token matches, tell the user. Resolve a token only when the user asks to use the token.

## Use a token

For a request to use a token, pass its exact address. If the user gives no address, pass a short description of the task. Shell-quote the argument as data.

```sh
woof get '<address-or-terms>' --agent
```

1. If `get` returns a payload, the payload is the content of the token. Follow a prompt payload as instructions in this conversation, with the user's original request as the scope. Do not run `get` again to show or submit the result.
2. If `get` returns candidates, run the command from the output with the path of the clear match. If several candidates fit, show their paths and descriptions. Ask the user to choose. If no candidate fits, report that result.
3. If several projects match, retry with the project that the user named. Otherwise, ask the user to choose.
4. If the command fails, report the error.

If a payload instructs you to use another woof token, retrieve it when that instruction applies. Pass its address exactly as written, shell-quoted as data, and stay in the user's target project directory.

`get` runs each script that the token expands. The scripts run in the checkout of the selected project. woof does not undo the effects of a script. The kind of a candidate shows if the candidate is a script. If a token can reach a script that the user did not ask to run, read its resolution with `woof explain` first.

## Change the catalog

Start with the command for the change. Then follow the drafting steps in the output. Before you run the final command, show the result to the user.

- To add a token, run `woof add --agent`.
- To change a token, run `woof edit '<address>' --agent`.
- To create a project configuration, run `woof init --agent`.

In prompt content, `{{path}}` inserts a token's content. `{{~path~}}` produces an instruction to use that token later, without loading or running it. Write `{{{{` and `}}}}` for literal double braces.

woof cannot rename, move, retype, or remove a token. For these changes, edit the configuration file that `woof explain` reports. Then run `woof validate --agent`.

## Share a project

To share a registered project, run `woof export --project '<name>' --agent`. To receive a project, run `woof import '<archive>' --agent`. Import adds new items by itself. It asks for one decision for each conflict: an item that exists on both sides and differs. Each decision belongs to the user. Do not write a decision that the user did not make.

## Inspect the structure

When the user wants to see the configuration structure, use `woof tree --agent`. An optional path narrows the view, such as `woof tree 'git' --agent`. Use `--project '<name>'` or `--repo` for project definitions only.
