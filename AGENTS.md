# Agent Docs

Read [.agents/docs/index.md](./.agents/docs/index.md).

After a feature or change reaches its logical conclusion, use `woof-living-docs` to review the relevant living documentation. Update it only where needed. Do not do this preemptively.

Read [.agents/docs/project-vision.md](./.agents/docs/project-vision.md) to learn how woof started and where the owner wants woof to go. The vision is not a specification. The project, domain, and command briefs describe current behavior. The questions brief holds open decisions. Do not infer additional requirements from the vision, the project name, or the MAACS reference project.

## Local CLI

During development, use this checkout's CLI: `node cli/woof.mjs <command> --agent`. This overrides the skills' npx invocation. Use npx for checks of the published package or a packed release.

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
