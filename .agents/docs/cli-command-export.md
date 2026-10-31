# Export command

## Purpose and ownership

Export packages one registered project, so that another woof home can import it. Export owns archive assembly and destination naming. The sharing domain owns the rules for archive content.

## Inputs

Export requires a registered project name. It accepts no positional arguments. Export refuses repository projects.

## Behavior

1. Export loads the named project. It keeps only that entry in a copy of the registry.
2. Export validates the shared graph alone and the selected effective graph. It does not run scripts. If a validation fails, the export stops.
3. Export collects the archive content that the sharing domain defines. It rewrites checkout references to point to the exported copies.
4. Export builds and verifies the archive. Then export writes the archive privately to the exports area of woof home, under a new unique name.

## Output and exit status

On success, export reports the project, the archive location, the resource count, and an import follow-up command. Export never overwrites an existing archive. It never changes the source configuration and never runs scripts. A failure exits with status 1.
