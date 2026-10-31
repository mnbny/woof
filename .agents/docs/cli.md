# CLI

## Purpose and ownership

The CLI owns command registration, startup configuration checks, caller detection, shell completion, and shared presentation. Each command owns its operation and recovery.

## Startup and configuration lifecycle

First operational launch silently creates a missing home and current versioned configuration. Existing files are never rewritten implicitly. Unversioned, malformed, or mismatched documents fail with source-specific guidance instead of being stamped with a guessed version.

Migration requires explicit authorization on an applicable command. Validation is the migration-only entry point. The operation prepares every used document before replacement, preserves physical targets and modes, checks concurrent changes, and supports ordinary-failure rollback. Import migration remains prepared during review and applies with the completed import, registry last.

Commands include `get`, `projects`, `explain`, `validate`, `export`, and `import`. Shell completion is hidden from the normal command list and does not evaluate resources.

## Caller modes

The shared agent-mode contract owns caller identity, noninteractive execution, output, and permission boundaries. Commands retain their operations and adapt presentation to the caller. Terminal availability remains separate from caller identity.

Human selection and conflict review use Clack. Agents receive plain metadata, exact retries, and decisions handoffs. Non-TTY humans also receive an exit-1 handoff instead of a cancellation result; actual Clack cancellation exits 130. Agent mode grants no additional permission.

## Distribution identity

Source execution uses checkout changes directly. Standalone execution uses the generated artifact. Local npm/npx package execution uses a packed tarball and isolated caches, not a global link or public-release claim. Presentation templates and the project-owned execution skill ship with the package.
