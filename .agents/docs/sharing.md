# Sharing domain

## Purpose and ownership

Sharing moves a registered project between woof homes through a portable archive. Repository projects move through Git, and they cannot be exported or imported. The export and import commands own their flows. This domain owns archive content, review semantics, and application safety.

## Archives

- An archive is a standard ZIP file without a manifest. It holds the selected project's tokens and only their reachable shared dependencies, through immediate and deferred references. References follow the effective view, so overridden root definitions and unrelated tokens are omitted. An empty project exports no shared tokens. Pruning changes only the archive. It never changes the source registry.
- Shared dependencies that rely on a project override through either reference kind travel as project tokens. This also applies to their callers, including deferred cycles. Independent shared dependencies stay in the root configuration, so the exported shared catalog can resolve without the project.
- The archive includes only the files that the retained tokens declare, plus the project's configuration file, if one exists. Included payload bytes stay unchanged. An unchanged project configuration also keeps its original bytes.
- Export copies project files under `<repo>` into a project-specific directory. The exported references point to the copies. Export does not copy the checkout or undeclared script dependencies.

When woof reads an archive, it checks entry names, sizes, and checksums. It also checks that the central and local records agree. These conditions cause a failure: unsafe paths, duplicate destinations, required entries that are not regular files, multi-disk archives, and ZIP64. woof ignores entries that no definition references. These entries never become writes.

## Private content

Export replaces a private token's content with an inline placeholder. It keeps the token's address, type, metadata, and privacy flag. This applies to retained shared and project definitions. Export does not change local content.

Privacy applies only to explicitly marked tokens. Redaction occurs before dependency selection, so a private placeholder needs no payload files or referenced tokens. If another retained, unmarked token needs those files or tokens, export includes them. Export does not interpret a prompt file as configuration, even when that file contains JSON token definitions.

Import warns about incoming placeholders and continues. A placeholder that differs from a local value needs the same review as any other conflict. Identical placeholders at the same address need no decision. Placeholders at different addresses are not reuse candidates, because their original values are unknown. Reuse of populated tokens requires the same privacy setting.

A new project token is an addition even when it overrides an existing shared value. The shared token's name alone does not require conflict review.

Local recovery backups retain private values and files. Export privacy does not change backup or restoration behavior.

## Review

Secret declarations travel with their tokens. Secret values and their store never enter archives, import writes, or import backups. Export checks declared secret dependencies through ordinary reference validation. Import can save the bindings before local values are configured. After saving, it lists the imported project's requirements and reports missing local values as validation findings.

Secret bindings affect execution and are part of token identity for reuse. Tokens with different bindings are not interchangeable. Review shows binding differences. Token remapping leaves secret keys unchanged because they are not token addresses.

Import compares the archive with the local home. The items are shared tokens, the project entry, project tokens, project metadata, and files.

These items need no decision:

- An identical item at the same address.
- An incoming item that does not exist locally, unless the next list includes it. Import takes it.
- A file that only the decided tokens use. It follows their decisions. This applies to a token file that no other local token reads, and to the project configuration file that no other project shares.
- A checkout file that export copied into the archive, when the local token still reads the file from the checkout and the content is the same.

Import reviews these items one at a time:

- A conflict: an item that exists on both sides and differs.
- An incoming item that matches a local item that it could reuse.
- An incoming item that must use a new path.
- An item with an earlier decision that a later choice reopened.

Each item offers the choices that apply to it:

- **Keep existing** keeps the local item, or declines an item that the review shows.
- **Take incoming** adds or replaces the item. If local projects use a shared token through their own tokens, the review names those projects.
- **Add as new** stores the item at an unused token address or home path. A file must use a new path if remapping changes its content or if the file belongs to an added token.
- **Reuse existing** maps the item to a local item at another address with identical type and content. The local item keeps its metadata.

Project metadata and project override bindings allow only keep or take.

## Remapping

Accepted renames and reuses remap both reference kinds only in imported content, including prompt files. Local references keep their meaning, unless their own definitions are replaced. A project override stays bound to the address of its shared token. If reuse selects another definition, a project alias keeps this binding. Reuse rejects cycles of immediate references, but permits deferred cycles. woof never rewrites escaped examples or script bodies.

## Decisions

Decisions bind the archive, the observed source state, and earlier choices. If a later choice changes the context of an earlier choice, the earlier choice must be reviewed again. Saved decisions fail if the archive is different or the sources changed. If the review is incomplete, import writes nothing.

Each decision claims one physical destination. woof compares destinations after links resolve, even for files that do not exist yet. These items claim destinations: writes, kept files, the imported project configuration, and added files whose incoming content is missing. If two decisions claim the same file, the review reopens the conflicting choice.

## Application and recovery

After each item has a decision, woof checks each source snapshot and reuse snapshot again. Before the first write, woof saves a backup archive in the backups area of woof home. The archive holds the root configuration, each file that it references, and each existing file that the import replaces. Its paths are relative to woof home, so an extraction over woof home restores these files. If woof cannot save the backup, the import stops before any change. An import that changes nothing makes no backup. woof keeps every backup and has no restore command.

woof stages each write with its original mode. woof replaces resources and the project configuration before the root registry.

If a write fails, woof restores the completed replacements in reverse order. woof does not overwrite later edits during this restoration. If the restoration cannot finish, copies of the originals stay as recovery artifacts. woof does not promise atomic behavior across several files after a crash.

Explicit startup migration completes before the review. For this reason, rollback returns to the state after migration.

Validation follows a successful save and never undoes the save. Missing incoming files and cycles that the archive already contains do not block the review. woof saves them as chosen and reports them as findings.
