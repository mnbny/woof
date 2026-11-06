Secrets for token {{path}}: {{bindings}}.
For commands described by this token, prepend {{prefix}} to the command. The command must read the supplied environment variables itself. Keep these bindings with this token's instructions when composing it with other tokens.
Replace woof in the prefix with the executable or package invocation used to retrieve this token.
Use secret lookups only inside command substitution. Never run them on their own, enable shell tracing, read or display woof.secrets.json, or print secret values. If a lookup reports a missing value, ask the user to supply it locally before continuing.
