# Get command

## Purpose and ownership

Get is the main way to use a token. It resolves an exact address into its payload, or it helps the caller find the correct address. Get owns the lookup flow and its exit status. The token domain owns the resolution rules. The scripts domain owns execution.

## Inputs

- Query terms. If the query is an address in the effective view, get resolves it exactly. Otherwise, get uses the query as discovery terms. Several terms join into one query.
- An optional registered project, from the project option or a qualified address.
- The search option, which forces discovery.

## Flow

1. Get selects the project context. If several projects match, a human chooses in a picker. Other callers receive candidates with exact retry commands.
2. If the query is an exact address and search is not forced, get preflights the graph. Then get runs the scripts that the resolution needs and writes the payload.
3. Otherwise, get discovers candidates in the effective view.
   - Get returns the candidate list in these cases: forced search, an empty query, an agent caller, a caller without a terminal, or no results.
   - In other cases, a human at a terminal picks a candidate. Get then resolves the candidate like an exact address.

## Output and exit status

- Get writes the payload to standard output exactly as resolved, without decoration, in both modes.
- If the tokens of a repository project depend on woof home tokens or files, get writes one warning to standard error.
- Each candidate shows its path, kind, description, tags, and an exact follow-up command. The follow-up command keeps the project and agent mode.
- Forced search and an empty query succeed, even with no matches. An exact miss without an interactive choice exits with status 1.
- An interrupt cancels the active scripts and exits with status 130. woof does not roll back completed script effects.
- Other failures exit with status 1. The guidance recommends discovery, or an exact address with an explicit project.
