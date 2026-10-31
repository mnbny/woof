# Init command

## Purpose and ownership

Init creates an empty project configuration. It creates a repository configuration in the current checkout, or it registers a project in the home registry. Init owns the questions, the handoffs, and the write. The configuration domain owns document structure. The projects domain owns selection.

## Inputs

- The repository option selects a repository configuration. An optional argument names one of the recognized locations in the checkout.
- The name option selects a registered project and supplies its name.
- The base path and worktree pattern options add project metadata. They can repeat. They apply only to a registered project.

The repository option cannot be combined with the name option or the path options.

## Behavior

1. If the target is missing, a human chooses it. Outside a checkout, the target is always a registered project. Other callers receive the exact command for each target.
2. A repository configuration needs a checkout. Inside Woof home, init refuses, because Woof ignores repository configuration there. If the location is missing, a human chooses it. Other callers receive the command for each location.
3. A registered project needs a name. A human enters it. The suggestion is the checkout folder name, if that name is a valid token name. Other callers receive a command with a name placeholder.
4. If no path options are given, a human enters base paths and worktree patterns. The base path suggestion is the current checkout, relative to the home directory when possible. Paths are optional. Without paths, only the project option selects the project.
5. A repository configuration holds only the current schema version. Init never replaces a repository configuration in any recognized location.
6. A registered project is an inline entry in the root configuration. It holds only the given metadata. Init replaces the root configuration atomically and keeps its other content, key order, and file mode. Init never replaces a registered project.

## Output and exit status

On success, init reports the created file. For a registered project, init also reports the paths and how Woof selects the project. A handoff or a failure exits with status 1 and writes nothing. An interactive cancellation exits with status 130.
