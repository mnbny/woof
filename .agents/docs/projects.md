# Projects

## Purpose and ownership

The projects domain selects the project context for a command. A project groups related checkouts and worktrees under one set of overrides. The token domain owns the overlay rules.

## Project kinds

- A registered project has a name in the home registry. Its definition is inline or in a separate file in woof home. Only registered projects can be exported or imported.
- A repository project comes from one configuration in a checkout. It has no name. Git shares it, and it cannot be exported or imported.

woof detects the checkout through Git. For this reason, each linked worktree is a separate checkout root. A checkout can hold only one repository configuration in the recognized locations. If two distinct files exist, selection fails. Links to the same file count as one file.

## Selection order

1. An explicit registered project, from the project option or a qualified address. An unknown name causes a failure.
2. The repository configuration of the current checkout. Inside woof home, woof skips this step.
3. The single registered project whose metadata matches the caller's directory.
4. If several projects match, a human chooses interactively. Other callers receive the candidates with exact retry commands.
5. If no project matches, the root definitions apply alone. woof never invents a default project.

woof never persists a selection. Each invocation selects again.

## Metadata matching

The metadata of a registered project lists checkout base paths and worktree patterns. Several developers can keep their own locations in one definition. A path that does not exist locally causes no failure.

- Each path must be absolute or start from the user's home directory.
- A base path matches the caller's directory and each directory below it.
- A worktree pattern matches the caller's directory or one of its ancestors.
- woof compares existing paths after links resolve.
