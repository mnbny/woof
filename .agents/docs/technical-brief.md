# woof technical brief

## Execution model

woof is written in TypeScript and runs on Node.js. Three entry points have the same behavior:

- Source execution loads TypeScript through tsx. It resolves dependencies from the woof checkout, so it works from any caller directory.
- The standalone bundle is one generated module. It embeds the runtime code. It reads the agent templates, the edit page, the readme, and the execution skill from the package at runtime. It needs no installed dependencies and no TypeScript loader. The pack step builds the bundle. The repository does not commit the bundle.
- Package execution runs the bundle from the npm package through npx, or from a packed tarball. It needs no global installation.

Each invocation parses the arguments, runs the startup checks, and runs one command. The readme command skips the configuration checks. woof keeps no daemon, persistent cache, or index between invocations.

Personal data is in woof home, outside all checkouts. An environment setting can move woof home to a different location.

## Organization and ownership

The repository keeps these areas separate: CLI behavior, shared utilities, agent presentation templates, development tooling, tests, skills, and agent documentation.

- Each command owns its operation, write order, recovery, and reports.
- Shared utilities own responsibilities that several commands use. These responsibilities are configuration schema and versions, migration, home paths, resource locations, project selection, token resolution, discovery, script execution, archive coding, import planning and application, and terminal presentation.
- A helper that only one command uses stays with that command.
- The execution skill ships with the package for woof users. The living-docs skill maintains this documentation system. The living-docs skill does not ship with the package.

## Dependency roles

- tsx runs the source. esbuild bundles and minifies the CLI.
- citty defines the commands. Clack and ansis supply terminal presentation.
- The edit command serves its page from the Node.js HTTP server. Marked renders the Markdown preview. The page loads pinned daisyUI styles from a CDN, so the page has no styles without a network connection.
- Valibot validates the configuration structure. woof's own checks enforce reserved keys and token names.
- Pico search ranks discovery matches. Picomatch matches worktree patterns. fflate reads and writes ZIP archives. diff shows the differences in import review.
- TypeScript checks the source with strict shared compiler settings. ESLint and Prettier enforce code and formatting conventions. Vitest runs the tests.

The bundle embeds every runtime library. For this reason, all packages are development dependencies. Dependencies and the package manager use exact versions. Node.js support follows the engine declaration in the package manifest.

## Cross-cutting conventions

- woof stages each write to configuration and woof home files. Before the write, woof checks the source state again. woof keeps the original bytes and modes for rollback.
- Startup checks, discovery, explanation, validation, export, and import never run scripts.
- Human mode and agent mode run the same operations. They differ only in presentation.
- All text that agent mode prints comes from a markdown template. Code supplies only the values. Human mode keeps its wording in the code.
- POSIX is the supported target for process cleanup. Other operating systems have weaker guarantees.

## Validation and tests

Repository validation runs four steps in sequence: formatting, linting, type checking, and the build. Formatting and linting can rewrite files. If a step fails, the later steps do not run, and the build does not generate the artifact. Tests run separately.

A test must protect distinct behavior that is easy to break. Every project criterion for test authoring must be true. Subprocess tests bundle the current source. They run the bundle against an isolated home, checkout, caller project, and environment. Transfer and migration tests use local archives, temporary Git repositories, and injected failures. These tests do not touch real personal configuration.
