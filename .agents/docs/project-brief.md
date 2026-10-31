# Woof project brief

## Purpose

Woof is a local command-line application. It helps developers and coding agents find and use reusable instructions and scripts. It replaces scattered prompt files, snippets, and helper scripts with one catalog of structured, composable tokens.

## Product model

- Standard JSON stores versioned definitions. Authors choose ordinary token names freely. Woof-owned structure uses `$`-prefixed keys.
- A token supplies stored text, a file-backed prompt, a reference to another token, or computed script output. Callers use one lookup interface for all of them.
- The token model follows the concepts of the Design Tokens Community Group (DTCG): groups, aliases, tiers, and modes. Woof adapts these concepts for instructions and scripts. Woof files are not compatible with DTCG files.
- A shared root catalog supplies defaults. One selected project overrides whole tokens. References resolve against that merged view.
- A project is registered by name in Woof home, or a repository configuration defines it without a name. All checkouts and worktrees of a project share one context.
- Resources can be shared, private, or outside a repository. Callers address them the same way in each case. Folder layout has no restrictions.
- Discovery uses token paths and optional metadata. Callers choose a resource before they read its body or run it.
- Registered projects move between homes as portable archives with explicit import review. Repository projects move through Git.
- Convention over configuration guides the design. If a reference is missing or forms a cycle, resolution fails before any computed side effect.

## Scope

Woof includes these parts:

- The CLI and its configuration model.
- Project selection and resolution.
- Computed resources.
- Migration, export, and import.
- Human and agent presentation.
- Standalone and local package execution.
- One project-owned execution skill, which ships with the package.

These items are outside the product: provider installers, hosted services, publishing, semantic search, graphical editors, and a general collection of development skills. MAACS is a reference for shared development practices and invocation structure. Its catalogs are not part of Woof.

## Vocabulary

- **Woof home:** the personal directory that holds the root configuration, registered project files, home resources, and exports. `<root>` refers to Woof home.
- **Checkout:** the Git repository or linked worktree that contains the caller's directory. `<repo>` refers to the checkout root. Computed scripts run in the checkout root.
- **Root configuration:** the document in Woof home that holds shared tokens and the project registry.
- **Registered project:** a named entry in the project registry. The entry is inline or refers to a separate configuration file in Woof home.
- **Repository project:** a project without a name, defined by a configuration file in a checkout.
- **Token:** a value with a dotted-path address. A token is a string, a typed resource object, or a namespace that contains more tokens.
- **Resource:** a token object with a declared type. The type is prompt, bash, node, tsx, or bun.
- **Alias:** a string token whose whole value is one reference to another token.
- **Effective view:** the root tokens, with the tokens of the selected project on top.
- **Discovery:** a search over metadata only, in the effective view.
- **Migration:** an explicit startup upgrade of configuration documents to the current schema version. Migration keeps the original bytes for rollback.
- **Export and import:** export packages a registered project as a portable archive. Import applies an archive after a review of every item.
- **Handoff:** plain output that returns a pending decision to the caller. A handoff replaces a terminal question.
