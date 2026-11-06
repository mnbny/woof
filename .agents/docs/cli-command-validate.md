# Validate command

## Purpose and ownership

Validate checks a token catalog and does not run scripts. People and agents use validate before lookup or export, and after manual edits. The token domain owns the preflight rules.

## Inputs

Validate takes an optional token address. It also takes an optional registered project, from the project option or a qualified address. If the address is inexact, a person at a terminal picks the token in the search picker of get, with the address as the search.

## Behavior

- Without an address, validate preflights every token in the selected effective view. The view is the root alone, a repository project, or a registered project.
- With an address, validate checks the token's reachable graph through both immediate and deferred references.
- Preflight checks references, immediate cycles, the independence of shared definitions, and declared files. Deferred cycles are valid. It never runs scripts.
- Secret declarations must have valid names and structure. The reference walk checks that their entries exist in the local store and contain nonempty values. Findings contain names only.
- Validate checks only the selected view. Each other registered project needs a separate run.

## Output and exit status

On success, validate states that the catalog is valid. With an address, it states that the token is valid, and gives the number of tokens that the token references. It also reports the selected project with the reason for the selection.

Validate reports problems across the selected graph in one run. Each problem names the token and its configuration file, or the reference chain. Errors in deferred dependencies include the path from the requested token. If validate finds a problem, it exits with status 1. A configuration that cannot load stops validation. The guidance then recommends a correction.
