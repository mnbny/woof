# Import command

## Purpose and ownership

Import applies a portable project archive to the local woof home after an explicit review. Import owns the review loop, the decision handoff, the application report, and post-import validation. The sharing domain owns the review semantics.

## Inputs

- One archive path.
- An optional decisions document from an earlier handoff.

Import runs from any directory. When the local project reads repository files, they come from the checkout of that project.

## Review loop

- Import warns about private placeholders in the archive before review. The warning does not require a decision or stop the import. A placeholder that conflicts with a local value still needs review.
- Import plans the archive against the local home. It applies the saved choices. It drops each choice whose context changed. It takes each item that needs no decision, so that only the items that need a decision reach the person or the agent.
- Human review shows a colored diff for each item, then its notes. A token shows as its type, description, tags, and content text, followed by each of its files whose content differs.
- The actions that apply follow the diff. Take incoming comes first and is the default, and each action has a hint that says what it does. For Add as new, import asks for an address or path. For Reuse existing, import offers the matching candidates. If a choice is not valid, import reports the problem and asks again. Cancellation shows a warning, exits with status 130, and writes nothing.
- Agents and callers without a terminal receive the next item that needs a decision, and the decision document. The output includes a retry command that keeps the decisions path and the agent flag. The command exits with status 1. The caller saves the document with the new choice and runs import again. If no decisions path exists yet, the retry command suggests a decisions file next to the archive.

## Application report

After the review completes, import applies the changes. It reports completed, restored, pending, recovery, and warning entries, one entry per line. Import leaves out an empty list. It also lists earlier decisions that no longer needed a choice. If nothing needs to change, import writes nothing and shows a warning that nothing was imported. If the application fails, import exits with status 1 and shows the same report.

When import saved a backup, it shows the backup location after the report, also after a failure. Agent output tells the agent how to restore the backup, and that a restore needs the user's approval.

## Validation findings

After a save, import validates the shared catalog and every registered project. It does not run scripts. Findings go to standard error after the success report, and the command still exits with status 0. If a finding shows an unreadable configuration, import asks for a repair before the next woof run. Other findings point to the affected tokens and to project validation.
