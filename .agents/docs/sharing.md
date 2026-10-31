# Sharing domain

## Portable archives

Export requires an explicitly registered home project. Repository-defined projects use their repository for sharing. A standard ZIP contains one selected project and the shared definitions it needs. It has no manifest.

Export copies declared checkout payload files into a project-specific directory and updates the exported references. It preserves source files, project overrides, metadata, aliases, and raw payload bytes. It does not execute scripts or copy an entire checkout.

Archive handling checks format integrity and destination containment. Unreferenced entries do not become import writes.

## Review and ownership

Import reviews incoming definitions and files one item at a time. Identical definitions at the same address need no decision. Other items, including additions, require an explicit choice to keep, take, add, or reuse where applicable.

Taking shared content can affect existing users. Adding a token can require a distinct file destination. Reuse retains the selected existing definition and its metadata. Reference remapping applies only to imported content and preserves project overrides. Script bodies are not rewritten or executed.

## Decisions and recovery

Human and agent review use the same choices. Decisions bind the archive and observed source state. A later mapping can require an earlier choice to be reviewed again. Incomplete review makes no import writes.

Complete review triggers source rechecks and staged application. Explicit startup migration completes before import review. Import rollback restores the post-migration state after write failures. Original bytes and modes support rollback and retained recovery artifacts. Multi-file crash atomicity is not promised.

Validation runs after a successful save. Missing resources, broken references, cycles, and other catalog findings are reported separately from import success. Validation does not execute scripts or roll back the import.
