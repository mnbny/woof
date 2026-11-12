# Upgrade command

## Purpose and ownership

Upgrade finds the latest published woof release and gives guidance for switching the command pin and execution skill. It owns release lookup, released-skill inspection, and the upgrade report. The CLI brief owns shared startup and distribution behavior.

## Inputs and startup

Upgrade takes no positional arguments or command-specific options. It rejects migration. It skips home initialization and configuration checks, so a missing or invalid catalog does not block it.

Upgrade supplies its own skill guidance. The usual installed-skill notice is suppressed for the command, its help, and its errors.

## Behavior

1. Upgrade requires a fresh npm registry response that identifies the latest release by an exact version. Cached metadata cannot substitute for that response.
2. It locates that exact package and reads its bundled execution skill. It does not run the downloaded CLI or package scripts.
3. It reports the running package version, latest release, released execution-skill version, and installed skill copies. Package and skill versions are separate. Even when the package is current, an installed skill can need an update.

The command leaves catalogs and installed skills unchanged. npm can download the released package into its cache.

## Output and permission boundaries

Human output gives the exact command pin and directs the user to update the execution skill after switching versions.

Agent output also gives the released skill's local source. It directs the agent to switch pins, verify the selected release, replace older installed copies, and read the updated skill. Copies at the released skill version or newer need no replacement.

An explicit upgrade request authorizes updates to existing skill copies. A version check alone does not authorize changes to the command pin or installed skills. When no skill is installed, installation follows the selected release's permission guidance.

## Exit status

A complete report exits with status 0. Registry failures, invalid release metadata, package-read failures, or an unreadable released skill stop the report and exit with status 1.
