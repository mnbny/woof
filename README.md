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
| `woof import ARCHIVE` | Review incoming items, apply the import, then report validation findings. |

Applicable context commands accept `--project NAME` and `--agent`. Import also accepts `--decisions FILE`. Every command provides `--help`. Use `--migrate` before or after any command, or run `woof --migrate` on its own, to apply pending supported configuration migrations before continuing.

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

Put the root configuration at `~/.woof/woof.config.json`. If this file does not exist, the first operational launch creates it silently. Help and shell completion do not create the file. Edit this JSON file to add shared tokens and registered projects.

Configuration documents require `$schemaVersion: 2`. A referenced project document declares its own version; an inline project inherits the containing document version. Woof-owned keys start with `$`.

```json
{
  "$schemaVersion": 2,
  "conventions": {
    "commit": "Use seven-rule commits.",
    "tests": "Test meaningful behavior only."
  },
  "agents": "{{conventions.commit}} {{conventions.tests}}",
  "review": {
    "$type": "prompt",
    "$exec": "<root>/prompts/review.md",
    "$description": "Review a focused change.",
    "$tags": ["review"]
  },
  "environment": {
    "$type": "node",
    "$exec": "console.log(process.cwd())"
  },
  "$projects": {
    "microsoft": {
      "$metadata": {
        "$basePaths": ["/work/microsoft"],
        "$worktreePaths": ["/work/microsoft-*"]
      },
      "conventions": { "commit": "Use semantic commits." }
    },
    "acme": "<root>/projects/acme.json"
  }
}
```

Home registry projects are inline objects or `<root>/` references to versioned project configuration files. A repository configuration is a versioned project object, not a root registry. Put its token definitions and optional `$metadata` directly beside `$schemaVersion`, without a `$projects` wrapper. Woof recognizes `woof.config.json`, `.agents/woof.config.json`, and `.claude/woof.config.json` at the checkout root.

Ordinary token segments are case-sensitive ASCII letters, digits, underscores, and hyphens. Dots delimit namespaces. Values are strings, namespaces, or typed resource objects, not arbitrary scalars or generic arrays. Resource types are `prompt`, `bash`, `node`, `tsx`, and `bun`. Prompt `$exec` is one string; executable `$exec` is a string or a nonempty string array. Object resources can have optional `$description` and `$tags`; bare strings have no separate metadata fields. A project override replaces all metadata on the token. Unknown reserved keys fail. Prototype-sensitive names `__proto__`, `prototype`, and `constructor` are rejected explicitly instead of being silently dropped.

A string token or prompt `$exec` can reference a file. Every referenced prompt payload is raw UTF-8 text, even with a `.json` suffix. `$projects` references are different: they load versioned JSON project configuration. Missing marked files fail; they are never treated as inline code.

`<root>` always means the Woof home. `<repo>` means the detected checkout or worktree root, with no filesystem fallback. Shared root definitions cannot use `<repo>` resources. Project definitions can use both markers. Reads require regular files and containment; known configuration symlinks can point elsewhere without changing the declared root. Import writes preserve existing in-home symlinks and reject destinations that escape the allowed root.

## Resolution and project selection

Woof follows base-plus-project-mode resolution semantics, not full DTCG interchange compatibility. The root supplies the base. One selected project overlays whole tokens, including aliases and metadata. References resolve afterward against the merged view. Inherited tokens remain directly callable and discoverable.

Global definitions must validate independently and cannot reference project-only tokens or repository resources. Self-reference is a cycle, not parent reuse. Missing references and cycles fail before computed side effects. `{{path}}` interpolates references; `{{{{path}}}}` emits literal `{{path}}` once. Script source and generated output never trigger another interpolation pass.

Selection priority is explicit project, approved repository configuration, registered metadata match, calling-agent inference or clarification, then root alone. Repository candidates are `woof.config.json`, `.agents/woof.config.json`, and `.claude/woof.config.json`. Distinct files error; physical aliases count once. Config location never changes the checkout root. Repository discovery is skipped inside Woof home.

Metadata matches the normalized caller directory and its ancestors, with descendant and worktree-glob matching. Nested matches return ambiguity instead of guessing. No selected project means root-only resolution, not an invented default. Choices are not persisted.

`explain` reports selection and dependency provenance. `validate` preflights root alone or the selected merged view, or narrows to one reachable graph. Neither executes scripts.

## Computed resources

| Type | Invocation |
| --- | --- |
| `bash` | Available `bash`, with `-c` for inline source or the declared file. |
| `node` | The running Node executable, with `-e` for inline source or normal Node file module detection. |
| `tsx` | `npx --yes --package tsx@4.23.15 tsx`, with `-e` for inline source or the declared file. TypeScript execution is not typechecking. |
| `bun` | `npx --yes --package bun@1.4.4 bun run` for files or Bun `-e` for inline source. Bun-native module and dependency rules can fetch missing packages. |

Scripts run as child processes, not inside Woof. Working directory is the detected checkout root or the caller directory when no checkout exists. Array entries run independently and sequentially from the same initial directory; the first failure stops later entries, and working-directory or environment changes do not persist between entries. Output concatenates literally without inserted separators. Repeated references to one script token share one successful result only within one resolution; separate invocations rerun it.

Cold `tsx` and Bun acquisition can require registry access because `npx` fetches the pinned runtime packages themselves. A warm npm cache can avoid those downloads. `node` and `tsx` do not automatically fetch arbitrary packages imported by script source; those imports must already resolve in the script's runtime environment. Bun may fetch missing script dependencies through its native resolver. Woof has no separate dependency installer. Acquisition time depends on the environment and is not a fixed startup-latency guarantee.

Captured stdout is limited to 256 MiB per child process. Exceeding the limit is an explicit error, never silent truncation, and triggers the same owned-process cleanup as cancellation. There is no default execution timeout or public output-limit flag. On POSIX, cancellation terminates only the owned detached process group, escalates within a bounded period, and waits for descendants. Windows has parent-only termination; equivalent process-tree behavior is not claimed.

## Export and transfer

Export requires explicit `--project NAME`; repository-defined projects cannot transfer. The ZIP has no manifest or separate bundle-version document. Its root `woof.config.json` contains shared definitions and exactly one selected `$projects` entry. Other project entries are pruned only in the payload, never in the source registry.

Export retains inherited shared definitions, project overrides, metadata, and declared root-relative resource paths. It validates the independent root graph and selected merged graph without executing scripts. Shadowed shared files remain included. Referenced project JSON and raw payload bytes, including raw `.json` prompt files, are preserved.

Project-owned `<repo>` prompt and script files are copied into `<project>-repo-export/` in the archive. The exported project configuration points to those copies through `<root>`. For example, `<repo>/scripts/build.sh` in project `microsoft` becomes `<root>/microsoft-repo-export/scripts/build.sh`. Export requires the referenced checkout files to exist. It does not copy the checkout or discover script dependencies, and it does not change source files.

Archives use root-relative destinations and reject path escapes, conflicting destinations, and ZIP integrity errors. Unreferenced entries do not become import writes. Central and local names, sizes, CRC-32, and decompressed bytes must agree. ZIP64 is not supported.

Exports use exclusive unique names under home `exports` and report the full path; existing archives are never overwritten.

## Import review

Import reviews every incoming item that differs from the existing definition, including additions. An identical definition at the same address is a no-op. Review presents one item at a time and offers the actions that apply:

1. **Keep existing:** retain the local item. When no local item exists, decline the addition.
2. **Take incoming:** add or replace the item. Replacing shared content affects its existing users.
3. **Add as new:** provide an unused token address or file path. File-backed additions and rewritten prompt files need distinct storage.
4. **Reuse existing:** select a compatible existing item with identical authored content. Its existing metadata stays in place.

Reuse compares type and authored content without executing scripts. Script matching also preserves runtime, inline or file execution, and array order. Imported references follow accepted renames; existing local references stay unchanged unless their own definitions are replaced. Project overrides remain bound to the corresponding shared token. Escaped prompt examples and script bodies are not rewritten. A file that is also a project configuration is identified during review before any explicit replacement.

Human review uses Clack. Only actual cancellation exits 130. A non-TTY human or an agent receives an exit-1 decisions handoff. No import files change until review is complete. Decisions bind the archive and observed source state. When a later mapping changes an earlier decision's context, Woof identifies that decision and asks for review again.

A handoff supplies `archive`, `sources`, `conflicts`, `choices`, and the next unresolved item. Add a value under that item's ID in `choices`:

```json
{
  "<next-id>": "keep",
  "<another-id>": "take",
  "<renamed-id>": { "action": "add", "address": "conventions.alternate" },
  "<reused-id>": { "action": "reuse", "address": "conventions.existing" }
}
```

For file or project storage, `address` is a path under Woof home. Reuse candidates appear in the handoff. An unchanged handoff does not grant a choice, including on the last item. Keep the emitted metadata and prior choices when saving decisions.

After every choice is resolved, Woof rechecks source state and applies staged changes. Resources and project configuration replace before the root registry. Original bytes and modes support rollback on write failure; later edits are not overwritten during rollback. Recovery artifacts remain when restoration cannot finish. Multi-file crash atomicity is not promised.

Woof validates after a successful save without running scripts. Import returns success even if validation finds missing files, broken references, cycles, or other project problems. Findings identify the affected paths and next steps; repair them without repeating the import. If a reviewed replacement makes a registered configuration unreadable, repair the named configuration file before running Woof again.

Woof checks the home configuration, registered home project configurations, and the current checkout configuration on every invocation. The startup check does not read prompt or script payloads. Pending supported migrations require `--migrate`; current configurations ignore it. Migration completes before the requested command, so an incomplete or canceled import leaves import data unchanged from the post-migration state. Unsupported or unversioned input is never guessed or stamped with a new version. The known legacy root scaffold `{"schemaVersion":1}` is the supported legacy form.

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
