# Get command

## Purpose and ownership

Get is the main way to use a token. It resolves an exact address into its payload, or it helps the caller find the correct address. Get owns the lookup flow and its exit status. The token domain owns the resolution rules. The scripts domain owns execution.

## Inputs

- Query terms. If the query is an address in the effective view, get resolves it exactly. Otherwise, get uses the query as discovery terms. Several terms join into one query.
- An optional registered project, from the project option or a qualified address.
- The search option, which forces discovery.

## Flow

1. Get selects the project context. If several projects match, a human chooses in a picker. Other callers receive the project names and one retry command.
2. If the query is an exact address and search is not forced, get preflights the graph. Then get runs the scripts that the resolution needs and writes the payload.
3. Otherwise, a human at a terminal searches all tokens in one picker. If the caller gave a query, the picker starts with the query in the search. Forced search behaves the same. The list shows the project tokens first. The search matches every word against the path, description, tags, and alias target. Get resolves the chosen token like an exact address.
4. An agent caller or a caller without a terminal receives the candidates from discovery instead.

## Output and exit status

- Get writes the payload to standard output exactly as resolved, without decoration, in both modes.
- If resolution reaches a private placeholder, get warns once for that token on standard error. The resolved payload asks the user to supply the missing value. The warning does not change the exit status.
- If the tokens of a repository project depend on woof home tokens or files, get writes one warning to standard error.
- In the picker, each row shows the path, a scope badge, and the runtime of a script. The focused row adds the description and tags.
- In the candidate list, each candidate takes one line: its path, a scope badge (global or project), a runtime badge if it is a script, its description, and tags. One command that resolves a candidate follows the list. The command keeps the project and agent mode.
- An alias has no description of its own. People see the description and tags of the token that the alias resolves to. The search matches them. Agents see the alias target.
- Forced search and an empty query succeed, even with no matches. An exact miss without an interactive choice exits with status 1.
- An interrupt cancels the active scripts and exits with status 130. woof does not roll back completed script effects.
- Other failures exit with status 1. The guidance recommends discovery, or an exact address with an explicit project.
