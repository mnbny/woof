woof release information

Running version: {{current}}
Latest release: {{latest}}
Latest woof-execution skill: {{skill}}

Installed skill copies:
{{copies}}

When the user requests an upgrade:

1. Use {{command}} <command> --agent for all subsequent Woof calls in this conversation. Stop using earlier version pins.
2. Run {{command}} --version --agent to verify the selected release.
3. After switching, replace each installed woof-execution copy older than version {{skill}} with this directory: {{source}}
4. Read the updated SKILL.md and follow it for subsequent Woof calls. Copies already at this skill version or newer need no replacement. If no copy is installed, follow the installation guidance from the selected release.

An explicit user request to upgrade authorizes updating the existing skill copies. Reuse that approval. For a version check only, report the versions without changing the command pin or installed skills.
