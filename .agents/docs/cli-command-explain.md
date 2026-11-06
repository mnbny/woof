# Explain command

## Purpose and ownership

Explain shows how one token resolves. It runs nothing. It helps people and agents trace the selection, overrides, references, and files. The token domain owns the rules for preflight and provenance.

## Inputs

Explain takes one token address. It also takes an optional registered project, from the project option or a qualified address. If the address is missing or inexact, a person at a terminal picks the token in the search picker of get, with the address as the search. An agent must give the address.

## Behavior

Explain selects the project in the same way as lookup. Then explain preflights the token's immediate references. It loads prompt files and checks declared script files and secret dependencies. It checks that deferred targets exist but does not load their files or descend into them. It never runs scripts.

## Output and exit status

Explain reports these items:

- The selected project and the reason for the selection, or that only shared tokens apply.
- The requested token first, then each token that it reaches, in the order of the references, with an arrow between tokens. For each token, explain shows its scope badge, its runtime badge if it is a script, its source file, the shared definition that it overrides, its description, tags, references, secret binding names, and resolved resource files.
- Deferred references in a separate field on the token that names them.

Missing token targets, missing or empty secrets, and immediate reference cycles stop explanation with status 1. Errors identify the dependency without displaying secret values.
