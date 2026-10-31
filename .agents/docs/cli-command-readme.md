# Readme command

## Purpose and ownership

Readme prints Woof's user guide, so that people and agents can learn what Woof does. Root help tells agents to run readme first. The command owns guide lookup only. The guide content is the repository README. Living docs do not maintain the README.

## Behavior

- Readme takes no arguments other than the global flags.
- It prints the guide byte for byte in both caller modes.
- It searches upward from the current entry point for a README next to Woof's own package manifest. The search succeeds from the source checkout, from the checkout bundle, and from an installed package.
- Without a migration request, readme skips the configuration checks and does not create Woof home. For this reason, readme works when the configuration is broken. With an explicit migration request, startup runs first.

## Failure

If a standalone bundle is copied away from its checkout or package, it has no guide. In this case, readme exits with status 1. Readme never prints a README that belongs to another project.
