# Projects command

## Purpose and ownership

Projects summarizes the projects that woof knows: the project that the current directory selects, and the registered projects. It reads configuration only. It never reads token bodies. The projects domain owns the selection rules.

## Inputs

Projects takes no arguments other than the global flags. It does not accept a project option.

## Output and exit status

Projects reports these items:

- A summary: the current project and why woof selected it, several matching projects, or no project. Without a project, only shared tokens apply.
- The current project first, marked as current. A repository project takes the name of its checkout folder.
- Each registered project. A registered project that covers the directory but is not current is marked as a match.
- For each project, its configuration file, marked as inline when the project is stored in the root configuration. For a registered project, each base path and worktree path, with the home directory expanded.
- If no project exists, the command that creates one.

Projects gives no instructions and asks no questions. If a configuration cannot load, projects exits with status 1.
