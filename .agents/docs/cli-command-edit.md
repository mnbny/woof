# Edit command

## Purpose and ownership

Edit changes the content, description, or tags of one token. People edit in a local browser page. Agents edit through flags after the user approves the change. Edit owns the layer choice, the page, and the write. The token domain owns references and the effective view. Edit does not rename, move, retype, or remove a token.

## Inputs

- The path of a token in the effective view, and an optional registered project.
- The changes: new content, a description, or a tag set. A flag that is not given keeps its field. An empty description or an empty tag removes that field.
- A layer, when a project context shows a shared token: change the shared token for every project, or add an override in the project.

## What changes

- Inline content changes in the configuration.
- A prompt file changes in place. An override keeps its text inline, so the shared file stays the same.
- A script file stays outside woof. Edit shows the file, and changes only the description and tags.

Edit runs the same checks as add, and writes nothing until all checks pass. Edit also refuses a change when the token changed after it was opened.

## People

A person without change flags picks the token from a searchable list and chooses the layer when needed. Then woof opens a local page in the default browser and shows its address. The page shows the description, the tags, and the content. A second tab shows a Markdown preview. Raw HTML in the preview shows as text. For a script file, the page lists commands that open the file in common editors.

A failed save shows the reason on the page and keeps the changes. A save or a cancellation closes the page server. The page also closes after 30 minutes without activity.

The page server listens only on the local loopback address. It answers only requests that use the address host, the page origin, and a secret path. The page runs only its own script, and loads only pinned daisyUI styles.

## Agents

An agent without changes receives the current token: the type, the layer, the files, the description, the tags, and the content. The handoff tells the agent to work out the change from the conversation, to show the user the current and the new version, and to apply the change only after approval. It gives the exact command, with the content on standard input.

## Output and exit status

On success, edit reports the configuration file, the content file that changed, the layer, and a command to check the token. If the new values match the current token, edit reports that nothing changed. A handoff or a failure exits with status 1 and writes nothing. A cancellation exits with status 130. An expired page exits with status 1.
