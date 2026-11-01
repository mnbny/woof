<h1 align="center">woof</h1>
<p align="center">Design tokens for your coding agent's instructions.</p>

<p align="center">
  <img width="240" height="240" alt="image" src="https://github.com/user-attachments/assets/2a079bf2-b98b-42a3-aea2-156798055599" />
</p>

My prompts, conventions, skills, and scripts were everywhere: copied between repos, stashed in ignored folders, slowly drifting apart. Every new project started the same way. Dig up the last agent file, copy it, fix the few lines that differ. All of it Markdown, and Markdown doesn't compose.

Design systems solved this a long time ago. You don't paste a hex code into every component. You name the color once, point an alias like `color.primary` at it, and dark mode changes what the alias means. woof brings that to your agent instructions. You write each convention, prompt, or script once, as a named token. Tokens reference each other and build bigger instructions. Each of your projects overrides only what's different. Keep tokens shared or private, in the repo or out of it.

You don't run woof. Your agent does:

<img src=".github/assets/readme/commit.jpg" alt="you: use woof to commit this. agent: runs woof get commit convention, finds git.commit, runs woof get git.commit, follows the seven rules of a great commit message, and commits with the message Add export command.">

In a repo that overrides `git.commit` with Conventional Commits, the same request gets you `feat(cli): add export command` instead. Nothing copied. A companion skill teaches your agent to search woof, use what it finds, and check with you before it changes anything.

## How it works

### Shared defaults, project overrides

Your shared tokens live in your woof home, and your agent can find them from any project. A project overrides only what's different. Everything else comes from the shared tokens.

```text
shared
├─ git.commits.seven_rules    "Follow the seven rules of a great commit message…"
├─ git.commits.conventional   "Use Conventional Commits: type(scope): summary…"
└─ git.commit                 → git.commits.seven_rules

acme (project)
└─ git.commit                 → git.commits.conventional

globex (project)
└─ git.commit                 "Start every subject with the ticket ID, such as GLX-142…"
```

`acme` points the alias at the other shared rule. `globex` writes its own. Every other project keeps the seven rules.

Say `acme` is your team's repo. Its woof configuration lives in the repo, and everyone gets it through Git. `globex` is a client repo you can't commit to, so its configuration stays private in your woof home. woof finds it by path, worktrees included.

### Build instructions from pieces

A token can pull in other tokens with `{{…}}`. Build your agent instructions from pieces you already have:

```text
agents.instructions
  # Working in this repo
  - Commits: {{git.commit}}
  - Testing: {{testing.policy}}
  - Style: {{code.style}}
```

Your AGENTS.md or CLAUDE.md shrinks to one line, and the same line works in every repo:

```markdown
Run `woof get agents.instructions` and follow it.
```

In `acme`, the commit line comes out as Conventional Commits. In `globex`, it's the ticket rule. You never touch `agents.instructions`.

### Tokens that run

A token can also be a bash, node, tsx, or bun script. Some scripts feed your instructions. Others just do a job.

```text
git.branch    bash   git branch --show-current
checks.all    bash   pnpm lint && pnpm test && pnpm build
```

`You're on {{git.branch}}.` reads as `You're on feat/export.` And when you say "run the checks", your agent runs `checks.all`. Projects override scripts like any other token, so the same ask does the right thing in every repo.

### Ask in plain words

You don't have to remember token names. Give a token a description and tags, and your agent finds it by what it's for. Search reads only names, descriptions, and tags. It never loads every prompt or runs a script, so your agent fetches just the one it needs.

The companion skill, `woof-execution`, teaches your agent that loop: search, fetch, follow. It also writes tokens for you, so you never hand-edit JSON. Or Markdown. (Sorry, Markdown. It's not you, it's me.)

<img src=".github/assets/readme/save-token.jpg" alt="you: save that review checklist to woof. agent: runs woof get review checklist --search, finds nothing similar, drafts review.checklist with the description PR review checklist, and asks to save it. you: yes. agent: runs woof add review.checklist and saves it.">

Edits, sharing, and repo setup work the same way. Your agent proposes, and you approve.

### Share with a coworker

If you can commit to a repo, like `acme`, keep its woof configuration there, and Git shares it with your team. Client repos are another story. Your agent instructions don't always belong in someone else's codebase, but your coworkers on that client could still use them. So keep the configuration in your woof home instead, like `globex`, and share it as a file.

Ask your agent to export it. woof packs `globex`, your shared tokens, and every file they use into one zip:

<img src=".github/assets/readme/export.jpg" alt="you: share my globex setup with sam. agent: runs woof export --project globex, saves ~/.woof/exports/globex.woof.zip, and says to send it to Sam.">

On Sam's side, anything new comes straight in. Anything that differs from what Sam already has waits for Sam's choice, one at a time:

<img src=".github/assets/readme/import.jpg" alt="sam: import globex.woof.zip. agent: runs woof import globex.woof.zip, says git.commit is different from theirs, and asks to keep yours, take theirs, or save theirs under a new name. sam: keep mine.">

Before it writes anything, woof saves a backup.

## Getting started

woof runs through npx, so there's nothing to install. You need Node.js 22.13+, 24, or 26+.

Paste this into your agent:

```text
Run `npx @mnbny/woof readme` and set up woof for me.
```

Your agent reads this guide. The first time it runs woof, woof suggests the companion skill, and your agent asks you before installing it.

Next, fill it up. woof is only as good as the tokens you give it, so start with primitives: the conventions, prompts, docs, and skills you already have. Point your agent at them, and it saves each one as a token:

- **"Save our commit rules to woof."** Your agent drafts the token, shows it to you, and saves it once you say yes.
- **"Add the docs in `docs/conventions/` to woof."** Each doc becomes a token with a name and a description your agent can search.
- **"Turn my code review skill into a woof token."** Its instructions are now available in every project.
- **"Point my AGENTS.md at woof."** It moves your instructions into tokens and leaves one line behind.

Then put them to work:

- **"What does woof have for code review?"** It searches names, descriptions, and tags, and shows you what fits.
- **"Use the woof token for code review."** It fetches the matching token and follows its instructions.
- **"Use woof to commit this."** It finds your commit convention and follows it.
- **"Set up woof for this repo."** It creates the repo's woof configuration, committed or private. Your call.

## Under the hood

Everything below is plain JSON, and your agent writes it for you. Here's how it fits together, one piece at a time.

### Where tokens live

Your shared tokens live in one file in your woof home, `~/.woof/woof.config.json`. Your agent edits it through woof, and you can edit it by hand.

### Tokens

A token is a key in that file. Nested keys build its path:

```json
{
  "git": {
    "commits": {
      "seven_rules": "Follow the seven rules of a great commit message: …"
    }
  }
}
```

That's `git.commits.seven_rules`. A plain string is a prompt.

To help your agent find a token, swap the string for the long form, with a description and tags:

```json
{
  "$type": "prompt",
  "$exec": "Follow the seven rules of a great commit message: …",
  "$description": "How to write commit messages",
  "$tags": ["git"]
}
```

Keys that start with `$` belong to woof. Everything else is yours to name.

For a long prompt, keep it in a file. A plain string or `$exec` can point at it:

```json
"<root>/resources/review-checklist.md"
```

`<root>` is your woof home. In a repo's config, `<repo>` points at the repo.

### Aliases

A string that is exactly one reference is an alias:

```json
{
  "git": {
    "commit": "{{git.commits.seven_rules}}"
  }
}
```

Point `git.commit` at a different token, and everything that uses it follows.

### Composites

References work anywhere in text:

```json
{
  "agents": {
    "instructions": "# Working in this repo\n\n- Commits: {{git.commit}}\n- Testing: {{testing.policy}}"
  }
}
```

woof applies overrides first, then resolves references, so an override reaches every composite. Write `{{{{` and `}}}}` for literal double braces. A missing token or a loop fails before anything runs.

### Scripts

Set `$type` to `bash`, `node`, `tsx`, or `bun`, and `$exec` becomes the script. Here's `git.branch`:

```json
{
  "$type": "bash",
  "$exec": "git branch --show-current"
}
```

The script runs in the repo root, and its output becomes the value. `$exec` can also be a file, like `"<root>/scripts/checks.sh"`, or a list of scripts that run in order and stop at the first failure.

### Projects

A project changes tokens for one codebase. It holds only what's different, and everything else comes from your shared tokens. A project lives in one of two places.

#### In your woof home

A private project never enters the repo, so it works even where you can't commit, like `globex`. Ask your agent to set up a private woof project for the repo. It adds the project to your shared file under `$projects`, with the paths that select it:

```json
{
  "$projects": {
    "globex": {
      "$metadata": {
        "$basePaths": ["~/code/globex"],
        "$worktreePaths": ["~/code/globex-*"]
      },
      "git": {
        "commit": "Start every subject with the ticket ID, such as GLX-142…"
      }
    }
  }
}
```

woof selects `globex` anywhere inside `~/code/globex`, and in every worktree that matches `~/code/globex-*`.

#### In the repo

Ask your agent to set up woof for the repo. It creates a `woof.config.json` at the repo root, or in `.agents/` or `.claude/`. Commit it, and woof uses it whenever you work inside the repo, in any clone or worktree, so your whole team gets it. Here's `acme`'s, which points one alias elsewhere:

```json
{
  "git": {
    "commit": "{{git.commits.conventional}}"
  }
}
```

#### Which project applies

woof picks one project per run: the one you name, then the repo's own config, then the private project whose paths match. If nothing matches, your shared tokens apply alone.

## Reference

That's the tour. From here, it gets detailed fast: the full config, every rule, and every command. Your agent reads this part closely. You can skim.

### Config schema

Here's everything from the tour in one file, `~/.woof/woof.config.json`:

```json
{
  "$schemaVersion": 2,
  "git": {
    "commits": {
      "seven_rules": {
        "$type": "prompt",
        "$exec": "Follow the seven rules of a great commit message: …",
        "$description": "How to write commit messages",
        "$tags": ["git"]
      },
      "conventional": "Use Conventional Commits: type(scope): summary…"
    },
    "commit": "{{git.commits.seven_rules}}",
    "branch": {
      "$type": "bash",
      "$exec": "git branch --show-current"
    }
  },
  "testing": {
    "policy": "Run the tests before you push."
  },
  "checks": {
    "all": {
      "$type": "bash",
      "$exec": ["pnpm lint", "pnpm test", "pnpm build"]
    }
  },
  "review": {
    "checklist": "<root>/resources/review-checklist.md"
  },
  "agents": {
    "instructions": "# Working in this repo\n\n- Commits: {{git.commit}}\n- Testing: {{testing.policy}}"
  },
  "$projects": {
    "globex": {
      "$metadata": {
        "$basePaths": ["~/code/globex"],
        "$worktreePaths": ["~/code/globex-*"]
      },
      "git": {
        "commit": "Start every subject with the ticket ID, such as GLX-142…"
      }
    },
    "initech": "<root>/projects/initech.json"
  }
}
```

And `acme`'s repo config:

```json
{
  "$schemaVersion": 2,
  "git": {
    "commit": "{{git.commits.conventional}}"
  }
}
```

#### Values

| Value | Example | Means |
| --- | --- | --- |
| String | `"Run the tests before you push."` | Prompt |
| String that is exactly one reference | `"{{git.commits.seven_rules}}"` | Alias |
| String with references inside | `"Commits: {{git.commit}}"` | Composite prompt |
| String that starts with `<root>/` or `<repo>/` | `"<root>/resources/review-checklist.md"` | Prompt read from a file |
| Object with `$type` | `{ "$type": "bash", "$exec": "…" }` | Resource: a prompt or a script |
| Any other object | `{ "commits": { … } }` | Namespace |

#### Reserved keys

| Key | Belongs in | Value |
| --- | --- | --- |
| `$schemaVersion` | Every config file, at the top level | `2` |
| `$type` | A resource | `prompt`, `bash`, `node`, `tsx`, or `bun` |
| `$exec` | A resource | Prompt text, script source, or a `<root>/` or `<repo>/` file. Scripts also take a list. |
| `$description` | A resource | Optional text for search |
| `$tags` | A resource | Optional list of strings for search |
| `$projects` | Your shared file | Private projects by name: inline, or a `<root>/` path to the project's own file, like `initech` |
| `$metadata` | A private project | Optional `$basePaths` and `$worktreePaths` |
| `$basePaths` | `$metadata` | Paths that select the project, including everything below them |
| `$worktreePaths` | `$metadata` | Patterns that match the current directory or one of its parents |

#### Rules

- Token names use ASCII letters, digits, `_`, and `-`, and they're case-sensitive. Dots join names into a path.
- An unknown `$` key fails.
- A value is a string, a resource, or a namespace. Numbers, booleans, `null`, and bare arrays fail.
- `<root>` is your woof home. `<repo>` is the root of the selected project's checkout: the current checkout inside the project's paths, or else the project's first base path that exists. Without either, `<repo>` files fail. Shared tokens can't use `<repo>`. A file path can't be absolute or empty, can't use `..`, and must resolve to a regular file inside its root.
- Paths in `$basePaths` and `$worktreePaths` are absolute or start with `~/`. woof ignores paths that don't exist on your machine, so teammates can list their own.
- Shared tokens must resolve without a project. They can't reference project-only tokens or `<repo>` files.
- An override replaces the whole token, including its description and tags. A project can't replace a shared namespace with a token, or a token with a namespace.
- A missing reference or a cycle fails before any script runs. A token that references itself is a cycle.
- A checkout holds one repo config: `woof.config.json`, `.agents/woof.config.json`, or `.claude/woof.config.json`. Two different files fail.
- Every config file declares `"$schemaVersion": 2`. woof never upgrades a file on its own. When it asks for a migration, rerun the command with `--migrate`.

### Commands

Your agent runs these as `npx @mnbny/woof <command>`. Add `--help` to any command for its full options.

| Command | What it does | Options |
| --- | --- | --- |
| `woof readme` | Prints this guide. Agents run it first. | — |
| `woof get [query…]` | Prints a token's value when the query is its exact path. Otherwise, searches. | `--search` to always search, `--project <name>` |
| `woof add [path]` | Adds a token | `--type`, `--content`, `--description`, `--tag`, and one of `--shared`, `--repo`, or `--project <name>` |
| `woof edit [path]` | Changes a token's content, description, or tags | `--content`, `--description`, `--tag`, `--shared` or `--override`, `--project <name>` |
| `woof init [location]` | Creates a repo config or a private project | `--repo`, or `--name <name>` with `--base-path` and `--worktree-path` |
| `woof projects` | Shows which project the current directory selects, and lists private projects | — |
| `woof explain [path]` | Traces how a token resolves, without running scripts | `--project <name>` |
| `woof validate [path]` | Checks every token, or one token's graph, without running scripts | `--project <name>` |
| `woof export` | Packs a private project into a zip in `~/.woof/exports/` | `--project <name>` |
| `woof import <archive>` | Asks about each conflict in an archive, then applies it | `--decisions <file>` |

Every command also takes `--agent` and `--migrate`. `woof --help` and `woof --version` work too.

#### Options

- `--content` takes text, the path of an existing file, or `-` to read standard input.
- `--tag`, `--base-path`, and `--worktree-path` repeat: `--tag git --tag commits`.
- In `edit`, an empty `--description` or `--tag` removes it. `--shared` changes a shared token for every project, and `--override` overrides it in the selected project only.
- A qualified address, such as `'$projects.globex.git.commit'`, selects a project the same way `--project globex` does. Quote it so the shell leaves `$projects` alone.

#### Agent mode and exit status

- woof detects coding agents from markers in their environment. `--agent` covers any other caller.
- Agent mode runs the same operations, with plain text and no questions.
- When a command needs a decision, it prints the choices and the exact command to continue, writes nothing, and exits with status 1.
- `get` prints the value exactly as resolved, so you can pipe it.
- Exit status is `0` on success, `1` on a failure or a handoff, and `130` on a cancellation.

### Scripts

A script token runs each time your agent gets it, and whatever it prints becomes the value.

#### Runtimes

- `bash`: your bash.
- `node`: the same Node.js that runs woof.
- `tsx`: TypeScript through a pinned tsx, from npx. It doesn't type-check.
- `bun`: a pinned Bun, from npx.

#### Where the script lives

`$exec` holds the script itself, or points at a file:

- `<root>/…`: a file in your woof home.
- `<repo>/…`: a file in the selected project's checkout. Project tokens only.

#### Notes

- Scripts run in the selected project's checkout, the same root as `<repo>`. Without one, they run in the current repo root, or in the current directory outside a repo.
- A list of scripts runs in order and stops at the first failure.
- The first `tsx` or `bun` run may need the network.
- If a script fails, the lookup fails. woof doesn't undo what a script already did, and there's no timeout.
- Only `get` runs scripts. Searching, `explain`, and `validate` never do.

### Files and folders

Everything woof keeps lives in your woof home, `~/.woof`.

#### In your woof home

- `woof.config.json`: your shared tokens and private projects.
- `resources/`: files woof copied in for your tokens.
- `exports/`: archives from `woof export`.
- `.backups/`: backups that `woof import` saves before it writes.

#### In a repo

- `woof.config.json`, `.agents/woof.config.json`, or `.claude/woof.config.json`: the repo's project. Keep only one.

#### Notes

- woof creates its home and `woof.config.json` the first time it needs them.
- woof keeps every backup. To restore one, extract it over woof home.

### Limits and decisions

#### Limits

What woof doesn't do yet:

- There's no rename, move, or delete command. Edit the JSON by hand, or ask your agent to, then run `woof validate`.
- One project applies per run, so you can't layer personal overrides on top of a repo's config.
- Scripts take no arguments. Each run uses the script as written.
- On Windows, cancelling a script stops the script itself but not the processes it started. macOS and Linux clean up everything.
- The `woof edit` page loads its styles from a CDN, so it's unstyled offline.

#### Deliberate decisions

What woof does on purpose:

- An override replaces the whole token. To build on a shared value, reference its pieces from your override. A token can't reference itself.
- A change to a shared token reaches every project at once, the way a design token does. There's no version pinning.
- Repo configs travel through Git. Only private projects export.
- Script output is plain text. woof never looks for references in it.
- A composite that references a script runs it on every lookup, so keep scripts with side effects out of composites.
- Scripts run as you, with no sandbox, timeout, or undo. Before you get tokens from an unfamiliar repo, check its config with `woof explain`.
- Search matches names, descriptions, and tags as text. It isn't semantic, so good descriptions pay off.
- woof borrows design-token ideas, not the DTCG file format, so DTCG tools can't read woof files.
- woof runs locally and never calls a model. Your agent does the thinking.

## Development

```sh
git clone https://github.com/mnbny/woof.git
cd woof
pnpm install
node cli/setup.mjs # links ~/.local/bin/woof to this checkout
pnpm validate      # formats, lints, typechecks, and builds
pnpm test
```

Design notes for contributors and agents live in [`.agents/docs/`](.agents/docs/index.md).

## ...and why "woof"?

<table>
  <tr>
    <td>After this interaction, I refer to my agents as woof.</td>
    <td><img width="256" height="182" alt="telegram-cloud-photo-size-1-4954272345791073203-m" src="https://github.com/user-attachments/assets/d390675f-cf99-4acc-bca8-95a2a6076432" /></td>
  </tr>
</table>




