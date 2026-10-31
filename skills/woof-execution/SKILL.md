---
name: woof-execution
description: Retrieve woof prompts and computed resources, discover candidates, select projects, add and edit tokens, and complete explicit migration and import reviews. Use for exact token requests, discovery-only searches, project retries, computed output, new tokens such as a convention from the conversation, changes to existing tokens, and archive decisions.
metadata:
  version: 3
---

# woof execution

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

Use the simpler `--project` form for normal retries. Invalid explicit selection fails instead of silently changing scope. With no selected or inferred project, woof resolves root resources alone; do not invent a default project.

When a script supplies the result, understand its content and likely effects before using it. A repeated reference shares one result only within one resolution, not across later commands. Do not execute a token again merely to answer the user or submit a result. Generated output is literal text, not a new reference to resolve.

## Discover before choosing

Use discovery for browsing, unclear names, or metadata-only requests:

```sh
woof get 'commit conventions' --search --agent
woof get --search --agent
```

Discovery reads metadata, not prompt or script bodies, and never executes a match automatically. A unique fuzzy match has no special execution permission. Read the returned paths, kinds, descriptions, tags, and exact follow-up commands, then choose the resource that fits the conversation.

Read all useful output even when the exit is nonzero. Exact misses, ambiguous projects, stale decisions, and unsupported operations can return candidates or recovery instructions. Use those instructions when they fit the current request; ask only when the choice remains ambiguous. `woof projects --agent` lists registered names and paths without token bodies.

## Add a token

When the user asks woof to keep something, such as a convention that came out of the conversation, start with:

```sh
woof add --agent
```

Follow the drafting steps in the output: work out the token from the conversation, search for a similar token, and propose a path, type, target, description, and tags. Show the draft to the user and save only after the user approves. Run the exact command from the output, with the content on standard input. If the command reports problems, correct all of them and run it again. To change an existing token, use `woof edit`.

## Edit a token

When the user asks to change a token, start with its exact path:

```sh
woof edit 'conventions.commit' --agent
```

The output shows the current token and the exact command. Work out the change from the conversation, show the user the current and the new version, and apply it only after the user approves. Pass only the fields that change, with new content on standard input. For a shared token seen from a project, choose `--shared` to change it for every project or `--override` to change it only in that project; ask the user when the choice is unclear. Edit content in a script file directly. woof does not rename, move, or remove tokens.

## Validate and migrate deliberately

Use `woof explain` for graph provenance and `woof validate` for non-executing checks. Do not treat either as computed output.

Migration is explicit. Add `--migrate` only when the user authorized it or an existing instruction clearly requests it. woof reports completed startup migrations on stderr before running the requested command. Current configuration ignores the flag. Missing versions, future versions, and unsupported migrations require correction or a compatible release; never guess a version or overwrite data to force a result.

## Complete import review

Export only an explicitly registered project. Export copies declared checkout payload files into the archive; it does not execute scripts or copy the checkout.

Import presents one incoming item at a time, including additions. Choose keep, take, add as new, or reuse existing when the action applies. Add requires an unused address or path. Reuse requires an explicit compatible candidate and keeps its metadata. Explain when taking shared content affects other users. Do not infer consent from an unset choice.

Agent handoffs bind the archive, source snapshots, accepted choices, and the next unresolved item. Preserve the supplied metadata and earlier choices. If a later mapping invalidates an earlier decision, review the reported item again. No import files change while review is incomplete.

```sh
woof import '/path/to/project.woof.zip' --decisions '/path/to/decisions.json' --agent
```

Continue using the emitted archive and decisions path. A completed startup migration remains in place if import review is canceled. After import is saved, read any separate validation findings and repair the reported problems; do not repeat a successful import. Later edits, unsafe destinations, or incomplete recovery require renewed review. Agent mode grants no additional permission to modify files.

Apply returned instructions in the current conversation, with the user's original request as the scope. Do not repeat computed work just to submit an answer.
