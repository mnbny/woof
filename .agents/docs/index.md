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

- Description: Placeholder for the owner's product vision. Preserve the vision once supplied; do not update it with the `toolkit-living-docs` skill.
- Tags: `vision`

#### [project-brief.md](./project-brief.md)

- Description: Woof's purpose, scope, ownership, and shared vocabulary.
- Tags: `scope`, `vocabulary`

#### [technical-brief.md](./technical-brief.md)

- Description: Shared execution model, technical responsibilities, tooling roles, and engineering conventions.
- Tags: `architecture`, `build`, `dependencies`, `conventions`, `validation`, `testing`

#### [cli.md](./cli.md)

- Description: CLI ownership, installation identity, configuration checks, and shell completion.
- Tags: `cli`, `setup`, `configuration`, `completions`

#### [cli-flag-agent.md](./cli-flag-agent.md)

- Description: Caller detection, noninteractive execution, output, and permission boundaries.
- Tags: `cli`, `agent`

#### [cli-command-customize.md](./cli-command-customize.md)

- Description: Personal configuration ownership, creation, display, and recovery.
- Tags: `customize`, `configuration`

#### [cli-command-upgrade.md](./cli-command-upgrade.md)

- Description: Checkout ownership, update policy, preservation of local work, and recovery.
- Tags: `upgrade`

#### [questions-brief.md](./questions-brief.md)

- Description: Product and policy decisions that remain open.
- Tags: `questions`
