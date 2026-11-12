# Export command

## Purpose and ownership

Export packages selected shared and registered-project definitions so another woof home can import them. Export owns selection, archive assembly, and destination naming. The sharing domain owns archive content.

## Inputs

Export accepts one or more exact definition paths. An ordinary path selects a shared token or namespace. A qualified project path selects a whole registered project, or a token or namespace defined in that project. One selection can mix shared definitions and several projects. The working directory does not select an export scope.

Selection uses actual definitions. An inherited shared token cannot be selected through a project path. Namespace matching follows complete path segments. Overlapping selections are deduplicated within their scope. Any unknown path or explicitly selected empty namespace fails. A whole empty project remains exportable.

Without input, a person at a terminal picks a registered project. An agent receives guidance to supply paths. Repository projects cannot be exported.

## Behavior

1. Export builds a shared view and one effective view for each selected project. Project overrides apply within that project's dependency chain.
2. Export replaces private content with placeholders before it walks the selected definitions and their immediate and deferred dependencies. It checks references and declared files without running scripts. A failure in a retained dependency stops export.
3. Export assembles each scope from retained tokens. Partial project exports keep project metadata but omit unselected definitions. Shared dependencies whose meaning depends on project overrides travel with that project.
4. Export combines the scopes and required files into one archive. Checkout files receive project-specific destinations. Differing partial configurations that used the same source file receive separate archive paths.
5. Export builds and verifies the archive, then writes it privately under a unique name in woof home's exports area.

## Output and exit status

On success, export reports the selections, archive location, file count, and import command. It never overwrites an existing archive, changes source configuration, or runs scripts. A failure exits with status 1.
