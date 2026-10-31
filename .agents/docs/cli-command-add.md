# Add command

## Purpose and ownership

Add creates one token in the shared tokens, in a registered project, or in the repository configuration. Add owns the questions, the drafting handoff, the checks, and the write. The configuration domain owns document structure. The token domain owns references and the effective view. Add never edits or removes a token.

## Inputs

- A dotted token path.
- A type: prompt, or a bash, node, tsx, or bun script.
- The content, as text or from standard input.
- An optional description and tags, for discovery.
- One target: the shared tokens, the repository configuration, or a registered project.

## Content

woof saves text inline. One line that names an existing file becomes a file reference instead:

- A file in woof home keeps its place.
- For a project token, a file in the checkout keeps its place.
- woof copies other files into the resources area of woof home, because a reference must stay inside a root.

A prompt without a description or tags is saved as a plain string. Other tokens are saved as resource objects.

## Checks

Add checks the configuration with the new token in place. Nothing is written until all checks pass.

- The path must be free in its document. A path cannot pass through an existing token.
- The changed document must be valid, and every project that the change reaches must still combine with the shared tokens.
- The references and files of the new token must resolve. A shared token cannot depend on project tokens or checkout files.

A project token at the path of a shared token is an override. Add reports it.

## Flow

- A human answers one question for each missing input: target, path, type, content, description, and tags. Each answer is checked at once. After a failure, add shows the reason and asks the same question again.
- An agent without complete input receives a drafting handoff. The handoff tells the agent to work out the token from the conversation, to search for a similar token, to show the draft to the user, and to save only after approval. It lists the existing namespaces, the targets, and the exact command.
- With complete input, add reports every problem that it finds in one message.
- Add checks again when it saves, because the configuration can change during the questions. The save replaces the document atomically and keeps its other content.

## Output and exit status

On success, add reports the configuration file, the type, how the content was saved, the description, the tags, whether the token is an override, and a command to check the token. A handoff or a failure exits with status 1 and writes nothing. An interactive cancellation exits with status 130.
