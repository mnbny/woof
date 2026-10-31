---
name: woof-execution
description: Retrieve Woof prompts and computed resources, discover candidates, select projects, and complete explicit migration and import reviews. Use for exact token requests, discovery-only searches, project retries, computed output, and archive decisions.
metadata:
  version: 1
---

# Woof execution

Run `woof` from the user's target project and preserve the requested task and scope. Try the relevant command before investigating installation, source files, or dependencies. Agent mode changes presentation, not permission.

## Retrieve an exact resource

For a known token or action request, use an exact address:

```sh
woof get 'agents' --agent
woof get 'conventions.commit' --project 'microsoft' --agent
```

The qualified form is equivalent to project selection and must be shell-quoted because `$` has meaning to the shell:

```sh
woof get '$projects.microsoft.agents' --agent
```

Use the simpler `--project` form for normal retries. Invalid explicit selection fails instead of silently changing scope. With no selected or inferred project, Woof resolves root resources alone; do not invent a default project.

When a script supplies the result, understand its content and likely effects before using it. A repeated reference shares one result only within one resolution, not across later commands. Do not execute a token again merely to answer the user or submit a result. Generated output is literal text, not a new reference to resolve.

## Discover before choosing

Use discovery for browsing, unclear names, or metadata-only requests:

```sh
woof get 'commit conventions' --search --agent
woof get --search --agent
```

Discovery reads metadata, not prompt or script bodies, and never executes a match automatically. A unique fuzzy match has no special execution permission. Read the returned paths, kinds, descriptions, tags, and exact follow-up commands, then choose the resource that fits the conversation.

Read all useful output even when the exit is nonzero. Exact misses, ambiguous projects, stale decisions, and unsupported operations can return candidates or recovery instructions. Use those instructions when they fit the current request; ask only when the choice remains ambiguous. `woof projects --agent` lists registered names and paths without token bodies.

## Validate and migrate deliberately

Use `woof explain` for graph provenance and `woof validate` for non-executing checks. Do not treat either as computed output.

Migration is explicit. Add `--migrate` only when the user authorized it or an existing instruction clearly requests it. Woof reports completed startup migrations on stderr before running the requested command. Current configuration ignores the flag. Missing versions, future versions, and unsupported migrations require correction or a compatible release; never guess a version or overwrite data to force a result.

## Complete import review

Export only an explicitly registered project. Import reviews present one conflict at a time. Keep existing or take incoming for every conflict before application; cancellation, incomplete review, stale choices, and invalid candidates do not authorize live changes.

Agent handoffs contain the archive digest, complete conflict metadata, accepted choices, and the next unresolved conflict. Preserve earlier keep/take choices, and add an explicit choice for the next conflict yourself. An unset next choice is not consent. Saving an unchanged handoff must not apply an import, including on the last conflict.

```sh
woof import '/path/to/project.woof.zip' --decisions '/path/to/decisions.json' --agent
```

Continue using the emitted archive and decisions path. A completed startup migration remains in place if import review is canceled. Read application and recovery reports before retrying. Later edits, unsafe destinations, or incomplete recovery require renewed review, not a blanket overwrite. Agent mode grants no additional permission to modify files.

Apply returned instructions in the current conversation, with the user's original request as the scope. Do not repeat computed work just to submit an answer.
