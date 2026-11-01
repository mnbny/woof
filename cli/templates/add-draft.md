woof needs more input to add a token: {{missing}}.

Draft the token from the conversation:

1. Work out what the user wants to keep. Make the content usable without this conversation.
2. Check for a similar token with woof get 'TERMS' --search --agent. If one exists, ask the user whether to add a new token or to change the existing token with woof edit 'PATH' --agent.
3. Choose a path that fits the existing namespaces below. Each name in the path contains only ASCII letters, digits, underscores and hyphens. Avoid paths such as -draft- whose references use the reserved {{-...-}} marker syntax.
4. Choose the type: prompt for instructions or other text, or bash, node, tsx or bun for a script.
5. Write a one-line description and a few tags, so that discovery can find the token.
6. Choose one target below. Shared tokens are available in every project. A project token exists only in that project, and it overrides a shared token at the same path.
7. If the user wants the content omitted from exports, add --private to the command. The token will export with a placeholder. Local access still returns its value.
8. Show the user the path, target, type, description, tags, privacy setting and content. Save only after the user approves.

Existing namespaces:
{{namespaces}}

Targets:
{{targets}}

Then run this command with the approved values. Put the content between the WOOF lines, so that it goes to standard input:

{{command}}
