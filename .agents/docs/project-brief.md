# Woof project brief

## Purpose

Woof is a command-line application. Its product purpose, intended users, and integrations are not yet defined.

## Current scope

Woof provides a shared CLI foundation with three responsibilities:

- Personal configuration that remains under the developer's control.
- Checkout upgrades that preserve local work.
- Development and distribution tooling for building and checking the CLI.

MAACS is the reference for shared development practices and CLI behavior. Its skill and prompt catalogs are outside Woof's scope. Woof does not distribute project-local agent skills.

## Ownership and vocabulary

A **checkout** contains the source and generated executable for a Woof installation. It can be a Git repository or a linked worktree.

**Personal configuration** belongs to the developer and remains separate from the checkout and the caller's project.

**Customize** prepares personal configuration for the developer to edit. **Upgrade** updates the checkout that supplies the running CLI.
