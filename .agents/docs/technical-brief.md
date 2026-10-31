# Woof technical brief

## Execution model

Woof uses TypeScript on Node.js. Source execution resolves dependencies from its own checkout, even when the caller works in another project. The generated standalone bundle includes runtime code and required presentation assets and needs no dependency installation or TypeScript loader.

The bundle is the only committed build artifact. Source defines behavior; the build reproduces generated output. Local npm/npx package execution is verified with isolated caches and does not require global installation or publication.

Personal configuration remains outside the checkout. The detected checkout root supplies `<repo>` and script working directory; the Woof home supplies `<root>`. Known configuration symlinks do not redefine either root.

## Organization and ownership

The repository separates CLI behavior, shared utilities, development tooling, tests, and agent documentation.

Commands own operations, write order, recovery, and reports. Shared utilities own configuration validation, installation paths, project selection, resolution, transfer, migrations, and terminal presentation. A helper used by one command stays with that command; a shared utility needs a distinct shared responsibility.

Resolution uses root-plus-one-project overlays, late references, independent global definitions, and complete preflight before computed side effects. Discovery enumerates metadata only. Transfer uses a fixed manifest-free ZIP codec, conditional candidate validation, staged writes, and original-state recovery.

## Dependency roles and conventions

- tsx runs source. esbuild bundles the CLI, and terser minifies the generated executable.
- citty defines commands and shell completion. Clack and ansis provide terminal presentation.
- Valibot validates configuration. Pico discovers metadata without evaluating bodies. Picomatch matches worktree metadata. fflate reads and writes ZIP archives. diff renders import review.
- TypeScript checks source with strict compiler defaults. ESLint and Prettier enforce code and formatting conventions. Vitest runs automated tests separately from validation.

Dependencies and the package manager use exact versions. Compiler and linting compatibility can limit upgrades. Node.js support follows the package engine declaration and actual runtime verification; it does not imply equivalent behavior on every operating system.

## Runtime boundaries

Computed scripts use the running Node executable, available bash, pinned npx tsx, and pinned npx Bun. Cold runtime acquisition can require network; a warm cache can avoid it. Bun-native package resolution may fetch script dependencies. Woof does not implement a dependency installer or typecheck scripts.

Captured stdout is limited to 10 MiB per child and fails explicitly instead of truncating. POSIX cancellation cleans only the owned process group and waits for descendants. Windows has parent-only termination and no equivalent process-tree claim. Archive input and expanded data are capped at 100 MiB each and 10,000 entries, with portable path and integrity checks.

## Validation and tests

Validation runs formatting, linting, type checking, and the build in sequence. Formatting and linting can rewrite files. A failure stops later steps, including artifact generation. Tests run separately.

Tests protect distinct behavior that is easy to break. Test authoring must satisfy every project criterion. Coverage or test count alone does not justify a test.

Subprocess tests compile current source and isolate the checkout, caller's project, home, and environment. Transfer and migration checks use local archives, temporary Git repositories, restrictive child umasks, and injected failures without modifying real personal configuration.
