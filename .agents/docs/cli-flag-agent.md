# Agent mode

## Purpose and ownership

Agent mode lets the current coding agent use Woof without terminal questions. Commands return results, recovery guidance, or the decision needed to continue. Each command retains ownership of its operation.

## Caller detection

Shared detection and the explicit agent flag select the same mode. The flag supports callers that detection does not recognize. No flag forces a detected agent into human mode.

Detection uses execution markers in the environment. Specific caller markers take priority over generic agent markers. Incomplete provider context does not establish a provider identity.

Installed software, authentication settings, editor identity, and terminal availability do not establish caller identity. Agent mode applies when a terminal is available. Redirected human output does not become agent output.

## Execution and permission

Human and agent modes share the same command operations. Agent mode changes presentation and guidance. It does not grant permission or transfer command operations to the agent.

Complete authorized input performs the operation directly. Missing decisions remain in the conversation. Explicit permission already given remains valid. Defaults and terminal availability do not imply consent.

Invalid arguments fail before command actions. A negated agent flag cannot bypass detection or permit an operation.

## Output and recovery

Agent output is plain text without terminal questions, progress animation, color, or terminal hyperlinks. Help and early failures remain plain even when the environment requests color. Human mode retains terminal presentation.

Results and recovery reports use standard output. Standalone failures can use standard error. Failures return a nonzero status, including when a report contains the error.

Recovery guidance identifies the remaining action and preserves explicit agent mode for supported CLI retries. Reports distinguish completed work from pending recovery. A successful checkout update does not imply successful restoration of local work.

Shared configuration errors remain plain in agent mode. Customize and Upgrade remain available for configuration recovery. Their own results determine the command's exit status.
