# Agent mode

## Purpose and ownership

Agent mode lets the current coding agent use Woof without terminal questions. A command returns a result, candidates, recovery guidance, or the decision that it needs to continue. Each command keeps ownership of its operation.

## Caller detection

Detection and the agent flag select the same mode. The flag covers callers that detection does not recognize. No flag can force a detected agent into human mode.

Detection reads execution markers in the environment. Specific caller markers have priority over generic agent markers. Incomplete provider context does not identify a provider. These items do not identify a caller: installed software, authentication settings, editor identity, and terminal availability.

Agent mode applies with or without a terminal. Redirected human output does not become agent output.

## Execution and permission

Human mode and agent mode run the same operations. Agent mode changes only presentation and guidance. Agent mode grants no permission, and it does not transfer an operation to the agent.

If the input is complete and authorized, the command runs the operation directly. If a decision is missing, the command returns the decision to the conversation as a handoff:

- If several projects match, the command returns the candidates with exact retry commands.
- Discovery returns candidates with exact follow-up commands. Discovery never runs a match.
- Import review returns a decision document for the next unresolved item.

Explicit permission that the user already gave in the conversation stays valid. Defaults and terminal availability do not imply consent. Migration still requires its explicit flag. Invalid arguments fail before the command acts.

## Output and recovery

Agent output is plain text from markdown templates. It has no prompts, progress animation, color, or terminal hyperlinks. Help and early failures stay plain, even when the environment requests color.

Results, handoffs, errors, and recovery guidance go to standard output. A failure returns a nonzero status, even when the output contains guidance. Follow-up commands keep explicit agent mode and the selected registered project. Reports keep completed work separate from pending recovery.

## Execution skill recommendation

At the end of each agent-mode run, Woof looks for the woof-execution skill in the Claude and shared agent skill directories of the user's home. If no copy exists, or an installed copy has an older version than the skill in the package, Woof writes a recommendation to standard error. The recommendation tells the agent to inform the user, gives the install source and locations, and requires the user's approval before installation. Human mode never shows the recommendation.
