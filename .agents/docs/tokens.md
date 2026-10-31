# Token domain

## Data and versions

Standard JSON stores root and project documents. Every document declares `$schemaVersion: 2`; inline projects inherit the containing version. Woof-owned fields use `$` prefixes. Token segments use case-sensitive ASCII letters, digits, underscores, and hyphens. Prototype-sensitive names are rejected explicitly.

Values are strings, namespaces, or typed prompt/script resources. Optional descriptions and tags belong to the complete winning definition. Prompt payloads are raw text regardless of extension. `$projects` references instead load versioned JSON configuration.

## Resolution and scope

Root definitions form the base. One selected registered or repository project overlays whole tokens, including aliases and metadata. References resolve afterward against that merged view. Inherited entries remain callable without re-declaration.

Global definitions must validate independently and cannot reference project-only tokens or repository resources. Self-reference is a cycle, not parent reuse. Missing targets and cycles fail before computed effects. Double braces reference tokens; quadruple braces emit literal double braces. Script output is never reinterpreted.

Explicit selection, repository configuration, metadata matching, and calling-agent inference precede root-only fallback. The caller directory and ancestors drive metadata matching; ambiguity returns choices instead of guessing. No selected project means root alone, not an invented default.

## Discovery and computation

Exact get resolves a token or falls back to metadata discovery. Forced `--search` always discovers and never executes a match. Search uses normalized path, description, and joined tags across the selected effective view, not bodies or generated output.

Scripts preflight every reachable token and declared file before execution. bash, node, tsx, and bun run as independent child processes, sequentially for arrays, with literal output and no cross-invocation cache. Captured stdout is limited to 10 MiB per child. Owned-process cleanup handles cancellation and overflow without a default timeout or universal process-tree claim.
