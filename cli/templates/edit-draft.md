Edit {{path}}.

Type: {{type}}
Defined in: {{where}}
Configuration: {{configuration}}
Content: {{location}}
Description: {{description}}
Tags: {{tags}}

Current content:
{{content}}

Layers:
{{layers}}

1. Work out the change from the conversation.
2. Show the user the current and the new version. Apply the change only after the user approves.
3. Pass only the fields that change. Tags replace the current set. --description '' removes the description, and --tag '' removes all tags.
4. Put new content between the WOOF lines, so that it goes to standard input. If the content is in a script file, edit that file directly. Woof then changes only the description and tags.
5. If the command has LAYER, replace it with one flag from Layers.

{{command}}

Nothing was changed.
