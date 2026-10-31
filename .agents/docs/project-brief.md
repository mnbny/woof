# Woof project brief

## Purpose

Woof is a command-line application for developers and coding agents to find and use reusable instructions and scripts. Its delivered product model replaces scattered resource management with structured, composable tokens.

## Product direction

Standard JSON stores versioned resource definitions. Named tokens supply conventions, instructions, project context, and executable resources. Ordinary token names remain open-ended; Woof-owned structures use `$`-prefixed keys. Prototype-sensitive names are rejected explicitly.

Prompts can remain plain strings or use objects. Scripts require objects. Object resources support optional descriptions and tags; bare strings have no separate metadata fields. Discovery uses token paths and available metadata to help callers choose a resource without retrieving its body or executing it.

Project context selects overrides throughout late reference resolution. A project's worktrees share its logical identity. Resources can remain shared, private, or outside the repository without changing how callers address them.

The home registry selects projects by name. A discovered repository configuration defines one unnamed project directly. Both forms use versioned project schemas and root/repository resource markers.

Folder layout is unrestricted. Project resources can be kept together, split across directories, or stored inline. `<root>` always means Woof home, and `<repo>` always means the detected checkout, independently of the configuration file's directory. Resource reads and import writes enforce containment.

Bundles share explicitly selected registered projects and required shared dependencies while excluding other project entries. Repository-defined projects use Git and cannot use project import or export. Import conflicts require explicit keep/take choices and final validation before replacement. Missing required tokens and circular references fail before computed side effects.

Convention over configuration guides the design. The first product delivery is the CLI plus one project-owned execution skill, not a provider installer or development-skill collection. Broader authoring interfaces remain deferred.

## Delivered CLI responsibilities

- Silent first-launch home creation and explicit startup migration with original-state recovery.
- Exact and metadata-only lookup, project selection, explanation, validation, and registry listing.
- Computed bash/node/tsx/bun resources with preflight, literal output, and owned-process cancellation.
- Manifest-free project export, sequential import review, safe application, and rollback/recovery.
- Shared human and noninteractive agent presentation, standalone execution, and local npm/npx package use.

MAACS is a reference for shared development practices and invocation structure. Its catalogs are outside Woof's scope. Woof includes one original execution skill and does not distribute a general development-skill collection.

## Ownership and vocabulary

A **checkout** is a detected Git repository or linked worktree that can supply `<repo>` resources and script working directory. A **Woof home** supplies `<root>` and is independent of the caller's checkout.

The intended **project** identity groups related checkouts and worktrees under one resolution context. A **token** is a named resource that can supply stored content, references, or a computed value. The **root** is the shared base; one selected project overlays whole tokens before references resolve.

**Migration** is an explicit startup transition that preserves original bytes for rollback. **Export** packages a registered project; **import** reviews and applies a complete candidate only after every conflict is resolved and final validation succeeds.
