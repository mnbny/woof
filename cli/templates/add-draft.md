woof needs more input to add a token: {{missing}}.

Draft the token from the conversation:

1. Work out what the user wants to keep. Write the content as standalone instructions that make sense without this conversation.
2. Check for a similar token with woof get 'TERMS' --search --agent. If one exists, ask the user whether to add a new token or to change the existing token with woof edit 'PATH' --agent.
3. Choose a path that fits the existing namespaces below. Each name in the path contains only ASCII letters, digits, underscores and hyphens.
4. Choose the type: prompt for instructions or other text, or bash, node, tsx or bun for a script.
5. Write a one-line description and a few tags, so that discovery can find the token.
6. Choose one target below. Shared tokens apply to every project.
7. Show the user the path, target, type, description, tags and content. Save only after the user approves.

Existing namespaces:
{{namespaces}}

Targets:
{{targets}}

Then run this command with the approved values. Put the content between the WOOF lines, so that it goes to standard input:

{{command}}
