# Questions brief

## Purpose

This brief holds product and policy questions that need an owner decision. The domain brief or command brief that owns a settled behavior describes that behavior.

## Resolution

### Unmatched project context

If no project matches the caller's directory, woof resolves the root definitions alone. In the original direction, selection ended with a question to the user. A decision can define whether an unmatched directory returns the choice to the caller instead.

### Layered overrides

Each resolution overlays one project on the root. A repository project cannot combine with private personal overrides. Layers cannot stack. A decision can define whether more layers exist and how they rank.

### Extending shared values

A project override replaces the whole shared token. A token cannot reference the value that it replaces. A decision can define whether a project can extend a shared value, not only replace it.

### Change propagation

A change to a shared token reaches every project that uses the token. There is no preview and no version pinning. A decision can define whether shared changes need a safeguard.

## Computed resources

### Output interpolation

Script output is literal. A future decision can define whether generated output can add token references. The decision can also define how that affects side effects and validation.

### Action scripts in compositions

If a composite token immediately references a script, each lookup runs that script. A convention can define whether scripts with side effects belong in compositions or only in explicit requests.

### Portability

POSIX is the supported target for process cleanup. woof makes no claim of equivalent process-tree behavior on other operating systems. That behavior needs separate validation before any commitment to portability.

## Interaction and authoring

### Shortcuts

General lookup reaches every resource. No familiar shortcuts exist, such as a direct request for a project's agent instructions or for a named convention. A decision can define whether shortcuts exist and which shortcuts to add.

### Authoring interfaces

woof creates empty project configurations and adds tokens. It edits the content, description, tags, and export privacy of a token. People edit in a local browser page. Authors rename, move, and remove tokens directly in the source files. No hosted service, provider tooling, semantic search, or other authoring system exists. Their scope and priority are owner decisions. These decisions include which other authoring operations go through woof.
