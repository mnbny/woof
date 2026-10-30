# Woof technical brief

## Execution model

Woof uses TypeScript on Node.js. Source execution resolves dependencies from its own checkout, even when the caller works in another project.

The generated CLI bundle includes its JavaScript runtime dependencies. It runs without a dependency installation or TypeScript loader. Configuration defaults and command guidance are included in the bundle. Checkout upgrades require the installation's Git checkout.

The bundle is the only committed build artifact. Source defines behavior. The build reproduces generated output.

Personal configuration remains outside the checkout. The caller's working directory does not determine which installation Upgrade changes.

## Organization and ownership

The repository separates CLI behavior, shared utilities, development tooling, tests, and agent documentation.

Commands own their operations, the order of writes, recovery, and reports. Shared utilities own configuration validation, installation identity, state locations, and terminal presentation.

A helper used by one command stays with that command. Shared utilities need a distinct shared responsibility.

## Dependency roles and conventions

- tsx runs source. esbuild bundles the CLI, and terser minifies the generated executable.
- citty defines commands. Shell completion uses those command definitions.
- Clack and ansis provide terminal presentation.
- TypeScript checks source with strict compiler defaults. ESLint and Prettier enforce code and formatting conventions.
- Vitest runs automated tests separately from validation.

Dependencies and the package manager use exact versions. Compiler and linting compatibility can limit upgrades. Node.js support follows the requirements of the development tools and runtime dependencies.

Editor and workspace setup use the same project conventions as validation. Workspace preparation completes dependency installation before source setup.

## Validation and tests

Validation runs formatting, linting, type checking, and the build in sequence. Formatting and linting can rewrite files. A failure stops later steps, including artifact generation. Tests run separately.

Tests protect distinct behavior that is easy to break. Test authoring must satisfy every project criterion. Coverage or test count alone does not justify a test.

Subprocess tests compile current source and isolate the checkout, caller's project, home, and environment. They do not depend on a previous bundle or personal configuration. Upgrade tests use local Git remotes and isolate recovery state from the developer's work.
