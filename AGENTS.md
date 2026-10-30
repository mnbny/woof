# Agent Docs

Read [.agents/docs/index.md](./.agents/docs/index.md).

After a feature or change reaches its logical conclusion, use `ir-living-docs` to review the relevant living documentation. Update it only where needed. Do not do this preemptively.

This repository is a CLI scaffold. Product behavior has not been specified. Do not infer commands, integrations, or domain concepts from the project name or from the MAACS reference project.

## Run Validations Smartly

Validation command: `pnpm validate`

It formats, lints, typechecks, and builds the repository. Run it when it is logically appropriate, not after every iteration. Examples:

- After a feature implementation is fully complete.
- Before staging or committing files.
- When asked by the user.

## Tests

Tests are not part of the `pnpm validate` command deliberately. Run them separately with `pnpm test`:

- Pre-commit batch.
- After adding/removing/refactoring tests.
- When asked by the user.

### Test Authoring

Before writing a test, confirm that **all** conditions below are met. These requirements use **AND, not OR**. If any condition is unmet or cannot be established, do not write the test.

1. It provides worthwhile protection against mistakes or regressions.
2. It protects meaningful behavior that is easy to get wrong or break.
3. It adds protection that existing tests do not already provide.
4. It is neither trivial nor low-value, even if it covers something new.
5. Its purpose is to protect behavior, not merely to increase test count or coverage.

## Skills

Use globally installed skills when requested. This repository does not vendor project-local skills.
