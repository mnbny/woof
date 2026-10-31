# Projects command

## Purpose and ownership

Projects lists the registered projects. It also shows which context the current directory selects. It reads configuration only. It never reads token bodies. The projects domain owns the selection rules.

## Inputs

Projects takes no arguments other than the global flags. It does not accept a project option.

## Output and exit status

Projects reports these items:

- The selection kind for the current directory, the current scope, and the matching candidates. Projects marks an unnamed repository scope as not exportable.
- For each registered project: inline or referenced storage, the configuration file, the resource root, checkout paths with the home directory expanded, and worktree patterns.
- If no registered projects exist, guidance to register a project in the home registry or to define a repository project.

Projects lists ambiguous matches without a prompt. It persists no selection. If a configuration cannot load, projects exits with status 1.
