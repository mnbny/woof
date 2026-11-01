Edit {{path}}.

Type: {{type}}
Defined in: {{where}}
Configuration: {{configuration}}
Content: {{location}}
Description: {{description}}
Tags: {{tags}}
Private: {{private}}

Current content:
{{content}}

Layers:
{{layers}}

1. Work out the change from the conversation.
2. Show the user the current and the new version. Apply the change only after the user approves.
3. Pass only the fields that change. Tags replace the current set. --description '' removes the description, and --tag '' removes all tags.
4. --private replaces the content with a placeholder on export. --no-private removes the privacy flag, so the content can export again. Use only one of these flags. Replacing a placeholder's content preserves the privacy setting unless --no-private is given.
5. Put new content between the WOOF lines, so that it goes to standard input. If the content is in a script file, edit that file directly. woof can still change its description, tags and export privacy. To change a shared script for this project only, first run the command with --override alone. woof copies the script into the project and reports the copy. Then edit the copy.
6. If the command has LAYER, replace it with one flag from Layers.

{{command}}
