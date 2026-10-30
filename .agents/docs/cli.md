# CLI

## Purpose and ownership

The CLI owns command registration, startup configuration checks, caller detection, shell completion, and shared presentation. Each command owns its operation and recovery.

## Installation identity

Setup selects source execution for development or bundle execution for direct use. The executable link remains outside versioned Node.js installations.

Source execution uses checkout changes directly. Bundle execution uses the generated artifact. Both modes identify their own installation independently of the caller's working directory.

Setup registers supported shell completion without duplicate registration. Dependency installation does not perform shell setup automatically. Completion remains available to the shell but is hidden from the normal command list.

## Caller modes

The shared agent-mode contract owns caller identity, noninteractive execution, output, and permission boundaries. Commands retain their operations and adapt presentation to the caller. Terminal availability remains separate from caller identity.

## Shared configuration checks

Personal configuration is optional. Startup checks existing configuration without creating a missing file or rewriting saved content.

Invalid configuration blocks normal root execution and help. Customize and Upgrade remain available for recovery. Their own operations determine success or failure. Completion suppresses configuration errors so completion remains usable.

A configuration from a newer schema requires a checkout upgrade. Other configuration errors direct the developer to configuration repair.
