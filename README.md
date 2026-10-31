# Woof

Woof is a local CLI for reusable instructions, prompts, and computed resources. Standard JSON defines named tokens. Projects override shared definitions without losing inherited entries. Metadata discovery helps people and agents choose before retrieving a body or executing a script.

## Commands

| Command | Purpose |
| --- | --- |
| `woof get [QUERY...]` | Resolve an exact token or discover candidates. |
| `woof projects` | List registered projects and their configuration and matching paths. |
| `woof explain TOKEN` | Show selected project, token provenance, references, and declared files without execution. |
| `woof validate [TOKEN]` | Validate root, the selected merged catalog, or one reachable graph without execution. |
| `woof export --project NAME` | Export a named registered project and required shared resources to a unique ZIP under home `exports`. |
| `woof import ARCHIVE` | Review each conflict, then validate and apply the complete import. |

Applicable context commands accept `--project NAME`, `--agent`, and `--migrate`. Import also accepts `--decisions FILE`. Every command provides `--help`. `woof validate --migrate` is the migration-only entry point.

Use exact retrieval for a known address:

```sh
woof get 'agents'
woof get 'conventions.commit' --project 'microsoft'
woof get '$projects.microsoft.agents'
```

The quoted `$projects.NAME.PATH` form is equivalent to `--project NAME`; use the simpler `--project` form for retries. Ordinary `projects.*` remains an ordinary token path. Contradictory selectors fail before side effects. Quote the qualified form because `$` has meaning to the shell.

Use discovery to browse or inspect metadata:

```sh
woof get 'commit conventions' --search
woof get --search
```

`--search` always discovers; it never resolves a match automatically. Results include paths, authored kinds, available descriptions and tags, and exact follow-up commands. Search reads no prompt or script bodies, evaluates no references, has no public result cap, and never auto-executes a fuzzy match, even a unique one. An exact miss invokes discovery and returns nonzero with useful guidance. Empty discovery succeeds.

## Configuration

Configuration documents require `$schemaVersion: 2`. A referenced project document declares its own version; an inline project inherits the containing document version. Woof-owned keys start with `$`.

```json
{
  "$schemaVersion": 2,
  "conventions": {
    "commit": "Use seven-rule commits.",
    "tests": "Test meaningful behavior only."
  },
  "agents": "{{conventions.commit}} {{conventions.tests}}",
  "$projects": {
    "microsoft": {
      "$metadata": { "$basePaths": ["/work/microsoft"] },
      "conventions": { "commit": "Use semantic commits." }
    },
    "acme": "<root>/projects/acme.json"
  }
}
```

Ordinary token segments are case-sensitive ASCII letters, digits, underscores, and hyphens. Dots delimit namespaces. Values are strings, namespaces, or typed resource objects, not arbitrary scalars or generic arrays. Resource types are `prompt`, `bash`, `node`, `tsx`, and `bun`. Prompt `$exec` is one string; executable `$exec` is a string or a nonempty string array. `$description` and `$tags` are optional and replace all metadata when a project overrides a token. Unknown reserved keys fail. Prototype-sensitive names `__proto__`, `prototype`, and `constructor` are rejected explicitly instead of being silently dropped.

A string token or prompt `$exec` can reference a file. Every referenced prompt payload is raw UTF-8 text, even with a `.json` suffix. `$projects` references are different: they load versioned JSON project configuration. Missing marked files fail; they are never treated as inline code.

`<root>` always means the Woof home. `<repo>` means the detected checkout or worktree root, with no filesystem fallback. Shared root definitions cannot use `<repo>` resources. Project definitions can use both markers. Reads require regular files and containment; known configuration symlinks can point elsewhere without changing the declared root. Import writes remain strict and reject destination symlinks and escapes.

## Resolution and project selection

Woof follows base-plus-project-mode resolution semantics, not full DTCG interchange compatibility. The root supplies the base. One selected project overlays whole tokens, including aliases and metadata. References resolve afterward against the merged view. Inherited tokens remain directly callable and discoverable.

Global definitions must validate independently and cannot reference project-only tokens or repository resources. Self-reference is a cycle, not parent reuse. Missing references and cycles fail before computed side effects. `{{path}}` interpolates references; `{{{{path}}}}` emits literal `{{path}}` once. Script source and generated output never trigger another interpolation pass.

Selection priority is explicit project, approved repository configuration, registered metadata match, calling-agent inference or clarification, then root alone. Repository candidates are `woof.config.json`, `.agents/woof.config.json`, and `.claude/woof.config.json`. Distinct files error; physical aliases count once. Config location never changes the checkout root. Repository discovery is skipped inside Woof home.

Metadata matches the normalized caller directory and its ancestors, with descendant and worktree-glob matching. Nested matches return ambiguity instead of guessing. No selected project means root-only resolution, not an invented default. Choices are not persisted. During implicit discovery without a checkout, unavailable `<repo>` config pointers are excluded only from inference; explicit selection still fails loudly.

`explain` reports selection and dependency provenance. `validate` preflights root alone or the selected merged view, or narrows to one reachable graph. Neither executes scripts.

## Computed resources

| Type | Invocation |
| --- | --- |
| `bash` | Available `bash`, with `-c` for inline source or the declared file. |
| `node` | The running Node executable, with `-e` for inline source or normal Node file module detection. |
| `tsx` | `npx --yes --package tsx@4.23.15 tsx`, with `-e` for inline source or the declared file. TypeScript execution is not typechecking. |
| `bun` | `npx --yes --package bun@1.4.4 bun run` for files or Bun `-e` for inline source. Bun-native module and dependency rules can fetch missing packages. |

Scripts run as child processes, not inside Woof. Working directory is the detected checkout root or the caller directory when no checkout exists. Array entries run independently and sequentially from the same initial directory; the first failure stops later entries, and working-directory or environment changes do not persist between entries. Output concatenates literally without inserted separators. Repeated references to one script token share one successful result only within one resolution; separate invocations rerun it.

Cold `tsx` and Bun acquisition can require registry access. A warm npm cache can avoid those downloads. Bun can also acquire script dependencies through its own resolver. Woof has no separate dependency installer. Acquisition time depends on the environment and is not a fixed startup-latency guarantee.

Captured stdout is limited to 10 MiB per child process. Exceeding the limit is an explicit error, never silent truncation, and triggers the same owned-process cleanup as cancellation. There is no default execution timeout or public output-limit flag. On POSIX, cancellation terminates only the owned detached process group, escalates within a bounded period, and waits for descendants. Windows has parent-only termination; equivalent process-tree behavior is not claimed.

## Export and transfer

Export requires explicit `--project NAME`; repository-defined projects cannot transfer. The ZIP has no manifest or separate bundle-version document. Its root `woof.config.json` contains shared definitions and exactly one selected `$projects` entry. Other project entries are pruned only in the payload, never in the source registry.

Export retains inherited shared definitions, project overrides, metadata, and declared root-relative resource paths. It validates the independent root graph and selected merged graph without executing scripts. Shadowed shared files remain included. Referenced project JSON and raw payload bytes, including raw `.json` prompt files, are preserved. Application checkout contents and arbitrary script dependencies are not copied or inferred.

Project-owned `<repo>` prompt and script paths remain external requirements. Transfer validates marker syntax and all available inline/home content but does not open those files or invent them. Their bodies and internal references require normal `get` or `validate` in the target checkout. Repository-based project configuration pointers are also reported as deferred rather than inspected during transfer.

Archives are bounded to 100 MiB input, 100 MiB expanded bytes, and 10,000 entries. Entry names must be portable root-relative paths. Traversal, absolute paths, backslashes, drive/alternate-stream forms, trailing dots/spaces, special devices, and special file types reject. Unicode-NFC and case-folded duplicates reject. Extra unreferenced files reject. Central/local names, sizes, CRC-32, and decompressed bytes must agree.

Exports use exclusive unique names under home `exports` and report the full path; existing archives are never overwritten.

## Import review

Import preserves unrelated local tokens and projects. Shared and selected-project leaves conflict per dotted token path; project storage and metadata are explicit choices. Referenced prompt and script payloads conflict as whole files. Identical data needs no choice.

A changed external project configuration cannot silently replace an unrelated file or a config shared with another registered project, including physical aliases. Nonidentical raw payload destinations owned by registered project configuration reject for the same reason. Choose a nonconflicting source project-config location and re-export instead of relocating or overwriting implicitly. Unchanged selected data and byte-identical final JSON are true no-write exceptions.

When shared definitions or existing resource bytes change, final validation also checks other available home/inline registered project views and names any project that breaks. Pure selected-project additions need no new traversal of unrelated catalogs. Repo-based views remain external and deferred. All sources used for parsing, comparison, and validation keep stable observed bytes and digests; later edits reject rather than bless stale data.

Human review shows one conflict and diff at a time. Only actual Clack cancellation exits 130. A non-TTY human or an agent receives an exit-1 decisions handoff instead. Partial choices never partially apply.

A decisions document contains the archive digest, complete conflict metadata, accepted choices, and the next unresolved conflict:

```json
{
  "archive": "<archive-sha256>",
  "choices": { "<accepted-conflict-id>": "take" },
  "next": {
    "id": "<next-conflict-id>",
    "kind": "file",
    "path": "payload.txt",
    "existingDigest": "<existing-sha256>",
    "incomingDigest": "<incoming-sha256>"
  },
  "conflicts": ["<complete reviewed conflict metadata>"]
}
```

Choices use exact JSON values `keep` and `take`. Accepted earlier choices remain unchanged. The next conflict is identified by `next`, but its ID is deliberately absent from `choices`; an agent default is not consent. Add an explicit choice for it. Saving an unchanged handoff cannot apply, including on the last conflict. Keep `--migrate` in retries while the original source still needs it.

Complete choices trigger final validation, then staged application. Resources and project configuration replace before the root registry. Original bytes and permission modes support ordinary-failure rollback; later edits are not overwritten during rollback. Recovery artifacts are retained when restoration cannot finish. Multi-file crash atomicity is not promised.

Explicit migration prepares used documents without rewriting them during review. The prepared migration applies together with the completed import, registry last, using original source bytes for rollback. Incomplete, invalid, stale, or canceled review leaves the original data unchanged. Unsupported or unversioned input is never guessed or stamped with a new version. The known legacy root scaffold `{"schemaVersion":1}` is the supported legacy form.

## People and agents

Human commands share Clack presentation. Explicit and detected agent mode uses plain, noninteractive output with actionable recovery. Agent mode grants no extra permission. Human and agent paths use the same operations.

The project-owned [Woof execution skill](skills/woof-execution/SKILL.md) covers exact retrieval, metadata discovery, project retries, computed output, and explicit migration or import decisions. It requires no global installation.

## Local package execution and development

Woof is prepared for local npm/npx package execution without global installation or a source checkout. No publication, public package-name availability, or published release is claimed.

```sh
node cli/woof.mjs --help
node cli/woof.bundle.mjs --help
npx --package=/absolute/path/to/woof-0.0.0.tgz woof --help
```

The standalone bundle contains runtime code and required presentation assets. The project package also includes the execution skill. Source development resolves dependencies from its own checkout.

Use Node.js `^22.13.0`, `^24.0.0`, or `>=26.0.0`, and pnpm 12.16.1.

```sh
pnpm install --frozen-lockfile
pnpm validate
pnpm test
```

`pnpm validate` formats, lints, typechecks, and builds. Tests run separately with `pnpm test` and use isolated homes, checkouts, worktrees, caches, and local package archives.
