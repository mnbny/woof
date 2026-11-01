# Documentation Registry

## How to Read

Read this registry to determine whether documentation applies to the current task. Read a registered document only when explicitly asked or when its description or tags relate to the work. Do not read documentation just because it is available, and do not read unrelated documents.

## How to Update

- Add an entry when a documentation file other than this registry is created.
- Update its entry when the file is renamed or its purpose changes.
- Remove its entry when the file is deleted.
- Use the exact relative file reference or path as the entry heading.
- Keep descriptions terse and limited to the document's purpose and contents. Do not include technical details.

### Tags

Tags name a document's main subjects or workflows. They route agents to the documents that provide substantial guidance for their task.

- Choose tags from the document's purpose and scope, not from individual terms in its contents.
- Add a tag only when work on that subject or workflow needs the document's core guidance.
- Exclude incidental mentions, supporting details, and prerequisites.
- Use the smallest set that covers the document's main subjects or workflows.
- Reuse an existing tag for the same subject or workflow instead of adding synonyms.
- Review the full tag set whenever an entry changes. Remove tags that no longer meet these rules.

### Entry Format

Add each document using this format:

```md
#### [file-name.md](./file-name.md)

- Description: Very brief description of the document's purpose and contents.
- Tags: `related-topic`, `another-topic`
```

## Registry

#### [project-vision.md](./project-vision.md)

- Description: How woof started and where the owner wants woof to go: problems, founding ideas, and future ideas. Update only at the owner's request. Exclude from routine living-documentation maintenance.
- Tags: `vision`

#### [project-brief.md](./project-brief.md)

- Description: woof's current purpose, product model, scope, and shared vocabulary.
- Tags: `scope`, `vocabulary`

#### [technical-brief.md](./technical-brief.md)

- Description: Execution model, repository organization, dependency roles, cross-cutting conventions, and validation and testing practice.
- Tags: `architecture`, `build`, `dependencies`, `conventions`, `validation`, `testing`

#### [cli.md](./cli.md)

- Description: Command set, invocation and startup order, presentation conventions and exit status, and distribution.
- Tags: `cli`, `commands`, `presentation`, `distribution`

#### [cli-command-readme.md](./cli-command-readme.md)

- Description: User-guide output for people and agents who want to learn what woof does.
- Tags: `readme`

#### [cli-command-init.md](./cli-command-init.md)

- Description: Creation of repository configurations and registered projects, with handoffs for missing choices.
- Tags: `init`, `scaffolding`

#### [cli-command-add.md](./cli-command-add.md)

- Description: Creation of one token, content handling, checks before the write, and the drafting handoff for agents.
- Tags: `add`, `authoring`

#### [cli-command-edit.md](./cli-command-edit.md)

- Description: Changes to one token's content, metadata, or export privacy, the layer choice, the local browser page, and the agent handoff.
- Tags: `edit`, `authoring`

#### [cli-command-get.md](./cli-command-get.md)

- Description: Exact lookup, discovery fallback, candidate output, and lookup exit status.
- Tags: `get`, `lookup`

#### [cli-command-projects.md](./cli-command-projects.md)

- Description: Summary of the detected project and the registered projects.
- Tags: `projects`

#### [cli-command-explain.md](./cli-command-explain.md)

- Description: Resolution trace for one token, without script execution.
- Tags: `explain`, `provenance`

#### [cli-command-validate.md](./cli-command-validate.md)

- Description: Checks of the selected catalog or one token graph, without script execution.
- Tags: `validate`

#### [cli-command-export.md](./cli-command-export.md)

- Description: Project dependency selection, archive assembly, destination naming, and export report.
- Tags: `export`

#### [cli-command-import.md](./cli-command-import.md)

- Description: Review loop, decision handoff, application report, and post-import validation.
- Tags: `import`, `decisions`

#### [cli-flag-agent.md](./cli-flag-agent.md)

- Description: Caller detection, noninteractive execution, handoffs, output, and permission boundaries.
- Tags: `agent`

#### [configuration.md](./configuration.md)

- Description: Configuration documents, structure rules and views, resource references, home lifecycle, versions, and migration.
- Tags: `configuration`, `schema`, `tree`, `migration`

#### [projects.md](./projects.md)

- Description: Registered and repository projects, selection order, and checkout and worktree matching.
- Tags: `projects`, `selection`, `worktrees`

#### [tokens.md](./tokens.md)

- Description: Design-token lineage, project overlay, references, private placeholders, preflight and provenance, and discovery rules.
- Tags: `tokens`, `design-tokens`, `resolution`, `discovery`, `privacy`

#### [scripts.md](./scripts.md)

- Description: Computed resource runtimes, execution, output, failure, and cancellation.
- Tags: `scripts`, `execution`

#### [sharing.md](./sharing.md)

- Description: Project bundle scope, private content, import review semantics, remapping, decisions, and application safety.
- Tags: `sharing`, `export`, `import`, `privacy`

#### [questions-brief.md](./questions-brief.md)

- Description: Open product and policy decisions for resolution, computed resources, interaction, and authoring.
- Tags: `questions`
