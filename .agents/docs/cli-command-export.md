# Export command

## Purpose and ownership

Export packages one registered project, so that another woof home can import it. Export owns archive assembly and destination naming. The sharing domain owns the rules for archive content.

## Inputs

Export needs a registered project name. A person at a terminal without the project option picks the project from the registered projects. An agent must name the project. Export accepts no positional arguments and refuses repository projects.

## Behavior

1. Export loads the named project and applies its overrides to the shared catalog.
2. Export replaces private content with placeholders, then walks the project tokens and their reachable dependencies. It checks those references and declared files without running scripts. A failure in a retained dependency stops export. Unrelated tokens and overridden root definitions do not enter this check.
3. Export collects the archive content that the sharing domain defines. It keeps only the selected registry entry and the required shared dependencies. It rewrites checkout references to point to the exported copies.
4. Export builds and verifies the archive. Then export writes the archive privately to the exports area of woof home, under a new unique name.

## Output and exit status

On success, export reports the archive location, the file count, and the import command. Export never overwrites an existing archive. It never changes the source configuration and never runs scripts. A failure exits with status 1.
