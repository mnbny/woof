# Computed resources

## Purpose and ownership

The scripts domain runs computed resources and turns their output into token values. Resolution decides when a script runs. This domain decides how the script runs.

## Runtimes

- bash scripts run through the available bash.
- node scripts run with the same Node.js executable as woof.
- tsx and bun scripts run pinned runtime versions through npx. If the cache is cold, npx can need network access to fetch these runtimes.
- tsx does not typecheck scripts.
- Bun's native resolver can fetch missing script dependencies. For node and tsx scripts, imports must already resolve.

woof has no dependency installer. woof does not analyze script dependencies.

## Execution

- A marked execution value runs as a file. Any other value runs as inline source.
- Scripts run as child processes in the checkout of the selected project. The projects domain decides that checkout. Without that checkout, scripts run in the checkout or the directory of the caller.
- Array entries run in sequence. Each entry starts from the same directory and environment. The first failure stops the remaining entries. Directory and environment changes do not pass to the next entry.
- Each child process runs noninteractively, with quiet package-manager settings. Its error output goes to woof's standard error.

## Output

Standard output becomes the token value as literal text. Array outputs join without separators. If one resolution references a script several times, the script runs once. Each new invocation runs the script again.

woof captures at most 256 MiB of output from each child process. If a script exceeds this limit, the lookup fails explicitly. woof does not truncate the output.

## Failure and cancellation

A nonzero exit, a signal, or a missing runtime causes the lookup to fail. woof does not roll back completed effects. There is no default timeout.

On cancellation or output overflow, POSIX cleanup signals only the child's own process group. Cleanup escalates after a short time limit and waits until the descendants exit. On Windows, woof stops only the parent process and makes no claim about the process tree.
