# Import command

## Purpose and ownership

Import applies a portable project archive to the local Woof home after an explicit review. Import owns the review loop, the decision handoff, the application report, and post-import validation. The sharing domain owns the review semantics.

## Inputs

- One archive path.
- An optional decisions document from an earlier handoff.

Inside a checkout that defines a repository project, import refuses to run.

## Review loop

- Import plans the archive against the local home. It applies the saved choices. It drops each choice whose context changed.
- Human review shows a diff for each pending item, with the actions that apply. For Add as new, import asks for an address or path. For Reuse existing, import offers the matching candidates. If a choice is not valid, import reports the problem and asks again. Cancellation exits with status 130 and writes nothing.
- Agents and callers without a terminal receive the next item and the decision document. The output includes a retry command that keeps the decisions path and the agent flag. The command exits with status 1. The caller saves the document with the new choice and runs import again. If no decisions path exists yet, the retry command suggests a decisions file next to the archive.

## Application report

After the review completes, import applies the changes. It reports completed, restored, pending, recovery, and warning entries. It also lists earlier decisions that no longer needed a choice. If nothing needs to change, import reports that the review passed and writes nothing. If the application fails, import exits with status 1 and shows the same report.

## Validation findings

After a save, import validates the shared catalog and every registered project. It does not run scripts. Findings go to standard error after the success report, and the command still exits with status 0. If a finding shows an unreadable configuration, import asks for a repair before the next Woof run. Other findings point to the affected tokens and to project validation.
