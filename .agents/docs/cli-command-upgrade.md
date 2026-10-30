# Upgrade command

## Purpose and target

Upgrade updates the checkout that supplies the running Woof CLI. The caller's working directory does not select the target. An executable outside a Woof checkout cannot upgrade an unrelated project.

For a linked worktree, Upgrade targets that worktree and its current branch. The target needs a branch with a configured upstream. Detached checkouts cannot upgrade.

Both caller modes use the same checkout operation. The CLI owns Git changes and recovery.

## Update policy

Upgrade fetches the configured remote before it checks for incoming commits. A failed fetch cannot establish that the checkout is current.

Without incoming commits, Upgrade succeeds without inspecting or stashing local changes. A branch ahead of upstream can therefore be current.

Incoming changes permit only a fast-forward update. Upgrade creates no merge commit and does not rebase local commits.

Unless the caller explicitly permits stashing, staged, unstaged, and untracked changes block an incoming update. Agent mode reports the missing decision. Explicit permission already given in the conversation remains valid.

## Preservation and recovery

An authorized stash contains staged, unstaged, and untracked changes. Upgrade restores the stash it creates, including staged state. Unrelated stashes remain unchanged.

Restoration follows the pull attempt even when the pull fails. The recovery stash remains until restoration succeeds. A failed restoration can leave partially restored changes that require inspection before another restoration attempt.

A successful checkout update does not imply successful restoration. Reports distinguish the update, restoration, and remaining recovery work. If stash cleanup fails after restoration, that failure does not imply loss of local work. Failures return a nonzero status.

## Runtime boundary

Bundle execution needs no dependency installation after an update. When dependency declarations or locked versions change, source execution refreshes dependencies after a successful update and restoration.

If dependency installation fails, the report identifies dependency repair as remaining work. Upgrade preserves the selected entry point and remains available when personal configuration is invalid.
