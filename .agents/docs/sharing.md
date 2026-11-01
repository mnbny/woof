# Sharing domain

## Purpose and ownership

Sharing moves a registered project between woof homes through a portable archive. Repository projects move through Git, and they cannot be exported or imported. The export and import commands own their flows. This domain owns archive content, review semantics, and application safety.

## Archives

- An archive is a standard ZIP file without a manifest. Its root configuration holds every shared definition and only the selected project entry. Pruning changes only the archive. It never changes the source registry.
- The archive includes every file that the shared graph and the project graph declare, including shadowed shared files. It also includes the project's configuration file, if one exists. Raw payload bytes stay unchanged.
- Export copies project files under `<repo>` into a project-specific directory. The exported references point to the copies. Export does not copy the checkout or undeclared script dependencies.

When woof reads an archive, it checks entry names, sizes, and checksums. It also checks that the central and local records agree. These conditions cause a failure: unsafe paths, duplicate destinations, required entries that are not regular files, multi-disk archives, and ZIP64. woof ignores entries that no definition references. These entries never become writes.

## Review

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

Accepted renames and reuses remap references only in imported content. Local references keep their meaning, unless their own definitions are replaced. A project override stays bound to the address of its shared token. If reuse selects another definition, a project alias keeps this binding. woof never rewrites escaped examples or script bodies.

## Decisions

Decisions bind the archive, the observed source state, and earlier choices. If a later choice changes the context of an earlier choice, the earlier choice must be reviewed again. Saved decisions fail if the archive is different or the sources changed. If the review is incomplete, import writes nothing.

Each decision claims one physical destination. woof compares destinations after links resolve, even for files that do not exist yet. These items claim destinations: writes, kept files, the imported project configuration, and added files whose incoming content is missing. If two decisions claim the same file, the review reopens the conflicting choice.

## Application and recovery

After each item has a decision, woof checks each source snapshot and reuse snapshot again. Before the first write, woof saves a backup archive in the backups area of woof home. The archive holds the root configuration, each file that it references, and each existing file that the import replaces. Its paths are relative to woof home, so an extraction over woof home restores these files. If woof cannot save the backup, the import stops before any change. An import that changes nothing makes no backup. woof keeps every backup and has no restore command.

woof stages each write with its original mode. woof replaces resources and the project configuration before the root registry.

If a write fails, woof restores the completed replacements in reverse order. woof does not overwrite later edits during this restoration. If the restoration cannot finish, copies of the originals stay as recovery artifacts. woof does not promise atomic behavior across several files after a crash.

Explicit startup migration completes before the review. For this reason, rollback returns to the state after migration.

Validation follows a successful save and never undoes the save. Missing incoming files and cycles that the archive already contains do not block the review. woof saves them as chosen and reports them as findings.
