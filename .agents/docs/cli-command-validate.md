# Validate command

## Purpose and ownership

Validate checks a token catalog and does not run scripts. People and agents use validate before lookup or export, and after manual edits. The token domain owns the preflight rules.

## Inputs

Validate takes an optional token address. It also takes an optional registered project, from the project option or a qualified address.

## Behavior

- Without an address, validate preflights every token in the selected effective view. The view is the root alone, a repository project, or a registered project.
- With an address, validate preflights only the reachable graph of that token.
- Preflight checks references, cycles, the independence of shared definitions, and declared files. It never runs scripts.
- Validate checks only the selected view. Each other registered project needs a separate run.

## Output and exit status

On success, validate reports the number of inspected definitions, the selection, the project, and the scope. Validation stops at the first failure. Validate reports the source or the reference chain of the failure and exits with status 1. For a configuration failure, the guidance recommends a correction or an explicit migration.
