# Explain command

## Purpose and ownership

Explain shows how one token resolves. It runs nothing. It helps people and agents trace the selection, overrides, references, and files. The token domain owns the rules for preflight and provenance.

## Inputs

Explain takes exactly one token address. It also takes an optional registered project, from the project option or a qualified address.

## Behavior

Explain selects the project in the same way as lookup. Then explain preflights the reachable graph of the token. It loads prompt files and checks declared script files. It never runs scripts.

## Output and exit status

Explain reports these items:

- The selection kind, the selected project or the root-only scope, and the requested address.
- For each reachable token: its kind, origin, source file, resource root, the shared definition that it overrides, description, tags, references, and resolved resource files.

If a reference is missing or forms a cycle, explain reports the reference chain and exits with status 1.
