# Configuration

## Purpose and ownership

The configuration domain owns woof's JSON documents, their structure and versions, home creation, startup checks, migration, and resource references. The token domain owns token meaning. The projects domain owns project choice.

## Documents

- The root configuration in woof home holds shared tokens and an optional project registry.
- A registered project is inline in the registry, or the registry refers to a separate project configuration in woof home.
- A repository configuration is one project object without a name, in a checkout. It has no registry wrapper. It holds tokens only, because its checkout selects it.
- A registered project holds tokens and optional metadata. The metadata lists checkout paths and worktree patterns.

Every standalone document declares `$schemaVersion` 2. An inline project uses the version of the document that contains it. One physical file cannot be both the root configuration and a project configuration. Configuration references cannot form a cycle.

The schema version is the first field in a standalone document. The root configuration puts the project registry last, after all shared tokens. A project configuration puts its metadata immediately after the schema version. An inline project puts its metadata first. These rules also apply when woof saves or exports configuration. Other fields keep their relative order.

## Structure rules

- woof-owned keys start with `$`. An unknown reserved key causes a failure.
- Token names use case-sensitive ASCII letters, digits, underscores, and hyphens. woof rejects prototype-sensitive names explicitly.
- A value is a string, a namespace, or a resource object. Other scalars and generic arrays are not valid.
- A resource object declares a type and an execution value. A description, tags, and a boolean privacy field are optional. Privacy controls export of the content. A prompt takes one string. A script takes one string or a nonempty list of strings.
- A failure names the source file and the failing path. woof never drops valid ad hoc content.

## Structure views

Tree shows where definitions belong without their content. The full view includes shared tokens and all registered projects. A project view includes only that project's definitions, without inherited shared tokens. Repository configurations have a separate project view.

The view uses branch lines to show namespaces, project wrappers, and empty namespaces. Visible tokens follow their definition order, with the project registry after shared tokens. Names that JavaScript treats as array indices appear first in numeric order. Each token becomes a marker that distinguishes a script from a prompt or alias. Project metadata and document versions are omitted.

References to project configuration files expand into project structure. Tree does not read token payload files, evaluate references, or run scripts. An exact dotted path is relative to the selected scope. It selects a branch or leaf and preserves its parent keys. A missing path fails without a search.

## Resource references

`<root>` resolves against woof home. `<repo>` resolves against the detected checkout. The file that declares a reference does not change either root.

A string token, a prompt, or a script execution value that starts with a marker refers to a file. Other values are inline content. If a marked file is missing, resolution fails. A missing marked file never becomes inline code.

- Shared root definitions cannot use `<repo>`. Project definitions can use both markers. Without an active checkout, `<repo>` fails.
- Registry references must use `<root>`.
- A marked path cannot be absolute or empty. It cannot contain traversal segments. After links resolve, the target must be a regular file inside its root.
- A prompt file is raw UTF-8 text, for all file extensions. A registry reference loads a versioned JSON project configuration instead.

## Home lifecycle

If woof home is missing, the first operational invocation creates woof home with a copy of the starter configuration template. The creation is atomic and private. Concurrent first launches produce one complete file. Passive invocations do not create woof home or repair field order unless migration is requested.

Each invocation except the readme command checks these documents:

- The root configuration.
- Each referenced project configuration.
- The repository configuration of the current checkout. If the caller is inside woof home, woof skips this check.

These checks parse and validate the documents only. They do not read prompt or script payloads.

After all documents pass these checks, operational invocations repair reserved-field order. This repairs manual reordering on the next invocation. The repair preserves token values, their formatting, and their relative order. It follows symbolic links, preserves file permissions, and checks for concurrent edits before replacement. Correctly ordered files are not rewritten. Invalid documents are not repaired.

## Versions and migration

The starter configuration template sets the current schema version. If a version is missing, newer, malformed, or mismatched, the document fails with guidance for that source. woof never guesses or stamps a version.

Migration is explicit. With the migration flag, woof migrates supported pending documents before the requested command runs. Current documents ignore the flag. Each migration upgrades a document from one schema version to the next version. No migrations exist yet.

During migration, woof locks each target and stages the replacements. woof checks again for concurrent changes and keeps the physical targets and modes. After an ordinary failure, woof restores the originals. If restoration fails, recovery copies keep the original bytes. woof reports completed migrations on standard error.
