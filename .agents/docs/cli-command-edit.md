# Edit command

## Purpose and ownership

Edit changes the content, metadata, or export privacy of one token. People edit prompt content in a local browser page. They edit the description and tags in the terminal. Agents edit through flags after the user approves the change. Edit owns the layer choice, the page, and the write. The token domain owns references and the effective view. Edit does not rename, move, retype, or remove a token.

## Inputs

- The path of a token in the effective view, and an optional registered project.
- The changes: new content, a description, or a tag set. A flag that is not given keeps its field. An empty description or an empty tag removes that field.
- Secret bindings can be replaced or removed as a set. Other edits and overrides preserve them. The same reference checks used for other dependencies require the declared local values before saving.
- Privacy flags include or omit the content in exports. They cannot be combined. Other edits, including replacement of a placeholder and creation of an override, preserve the privacy setting.
- Callers can replace a script's argument descriptions as a list or remove them with an empty list. Other edits and overrides preserve them. The agent handoff shows the current descriptions. The interactive editor preserves them. Callers use a flag to change them.
- A layer, when a project context shows a shared token: change the shared token for all projects, or add an override for this project only.

## What changes

- Inline content changes in the configuration.
- Disabling privacy removes the field and preserves the content and other metadata. A prompt with no remaining metadata uses the plain string form. Disabling privacy alone on an already public definition makes no change.
- A prompt file changes in place. An override keeps its text inline, so the shared file stays the same.
- Edit does not change the content of a script file. Edit shows commands that open the file. For a script file, edit changes only the description, tags, and export privacy.
- An override of a script gets its own copy of the script files, so a change to the copy stays in the project. A repository keeps the copies next to its configuration. A registered project keeps them in woof home. If the edit does not finish, woof removes the copies.

Edit runs the same checks as add, and writes nothing until all checks pass. Edit also refuses a change when the token changed after it was opened.

## People

A person without change flags picks the token from the same search picker as get. An inexact path opens the picker with the path as the search. If a layer choice applies, the person then chooses the layer.

The content comes first:

- For a prompt, woof shows the page address and opens the page in the default browser after a short countdown. The page shows the content and a second tab with a Markdown preview. Raw HTML in the preview shows as text.
- For a script file, woof lists commands that open the file in common editors and continues.

On the page, a save checks the content and returns it to the terminal. A failed check shows the reason on the page, marks the content, and keeps the changes. A save or a cancellation closes the page server. The page also closes after 30 minutes without activity.

Then the terminal asks for the description and the tags, with the current values filled in. woof writes all changes once, at the end.

The page server listens only on the local loopback address. It answers only requests that use the address host, the page origin, and a secret path. The page runs only its own script, and loads only pinned daisyUI styles.

## Agents

An agent without changes receives the current token: the type, layer, files, description, tags, export privacy setting, and content. The agent drafts the change from the conversation and shows the user the current and new versions. The agent applies the change only after approval. The handoff gives the exact command, with the content on standard input. For a script, the override flag alone creates the override with its own copy of the script files. The agent then edits the copy.

## Output and exit status

On success, edit reports the configuration file, the content file that changed, the layer, and a command to check the token. If the new values match the current token, edit shows a warning that nothing changed. A cancellation is also a warning. A handoff or a failure exits with status 1 and writes nothing. A cancellation exits with status 130. An expired page exits with status 1.
