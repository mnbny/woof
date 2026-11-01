# Token domain

## Purpose and ownership

The token domain owns the effective catalog. It defines how definitions combine, how references resolve, how woof checks and explains a resolution, and how callers discover resources. The configuration domain owns document structure. The projects domain owns project choice. The scripts domain owns computed execution.

## Design-token lineage

woof models its token system on the format of the Design Tokens Community Group (DTCG). woof adopts the concepts but not the file format. woof documents are not DTCG interchange files, and DTCG tools cannot read them.

| DTCG concept     | woof equivalent                                             |
| ---------------- | ----------------------------------------------------------- |
| Group            | Namespace                                                   |
| Token value      | A plain string, or the execution value of a resource object |
| Token type       | Content kind: prompt, or a bash, node, tsx, or bun script   |
| Description      | Description, on resource objects only                       |
| Alias            | Reference to another token                                  |
| Modes and themes | Projects                                                    |

### Tiers

Authors arrange tokens in the usual design-token tiers. woof does not enforce tiers. Any token can fill any role, and names carry no tier meaning.

- **Primitive** tokens hold content directly: a string, a prompt file, or a script. For example, each specific commit convention is a primitive.
- **Semantic** tokens are aliases. A semantic token names a decision and points at a primitive. For example, the default commit convention is a semantic token.
- **Composite** tokens interpolate several references into larger instructions. For example, a project's agent instructions are a composite token. Composite tokens fill the role of component tokens.

### Modes

Projects are modes, and the root is the base. A selected project overrides tokens before references resolve. For this reason, a semantic token that points at a different primitive changes every composite that uses it. One mode applies in each resolution. An override replaces the whole token, including its metadata.

### Deliberate departures

- References use double braces, and quadruple braces escape them. woof uses double braces because instruction text often contains single braces.
- A reference can appear inside longer text, not only as a whole value.
- Scripts can compute token values. DTCG values are always static.
- Types describe content and runtimes, not visual value types. Values are text, not structured composites.
- Tags are a woof addition for discovery. woof has no extension fields and no deprecation fields.
- woof-owned keys use the `$` prefix, as DTCG keys do. The set of reserved keys is woof's own.

## Token model

A dotted path addresses each token. A leaf is a string or a typed resource object. Any other object is a namespace. A plain string is a prompt. A string whose whole value is one reference is an alias. Only resource objects have a description and tags.

## Effective view

Root definitions form the base. The selected project overlays whole tokens, including aliases and metadata. Metadata never merges across layers. A project leaf cannot replace a shared namespace. A project namespace cannot replace a shared leaf. Inherited tokens stay addressable and discoverable, and the project does not need to declare them again.

## References

- Double braces reference a token immediately and insert its resolved content. A tilde inside each end of the double braces marks a deferred reference. Quadruple braces escape either form and internal markers, with no lookup.
- A deferred reference produces an instruction to use the target token. It does not insert the target's content. The author supplies any conditions, and the agent retrieves the target when the instruction applies. Surrounding prose and backticks do not change the rendered instruction.
- Deferred instructions qualify the address with the selected registered project, including for inherited shared targets. Repository-project and root-context addresses stay unqualified. Their later lookup must use the same project context.
- References resolve late, against the effective view. For this reason, project overrides apply in all parts of a composition.
- Shared definitions must resolve without a project. They cannot depend on project-only tokens or repository resources.
- Both reference kinds require an existing token target. Namespaces are not targets. Only cycles made entirely of immediate references fail. Deferred cycles and deferred self-references do not expand content and are valid.
- A token that contains only a deferred reference is a prompt, not an alias.
- woof never scans script source or script output for references.

## Private values and internal markers

A resource can mark its content as private. The flag controls export only. Local lookup returns the value as usual. The flag belongs to the whole token, so a project override supplies its own privacy setting.

Export replaces private content with a reserved marker. Double braces with a dash inside each end delimit internal markers. Marker names contain no braces or whitespace. These markers do not refer to tokens. Quadruple braces escape a marker for a literal example.

Token creation and import remapping reject addresses that would produce internal markers instead of token references.

When resolution reaches a private marker, the result names the token and asks the user to supply its value. Lookup also warns on standard error. Aliases and compositions carry the same message. A placeholder is valid content and does not stop resolution. Replacing the marker stops the warning, while the privacy flag stays set for future exports.

## Preflight and provenance

Before any script runs, each resolution walks its immediate references. The walk loads prompt files and checks declared script files. For a deferred reference, it checks only that the target exists and obeys shared-definition independence. It does not load the target's files, follow its references, or warn about its private placeholder. Authoring and explanation use the same boundary.

Validation follows both reference kinds and checks every reachable token without running scripts. Each immediate expansion has its own cycle check, so deferred cycles do not cause false failures. Errors reached through deferred references include the dependency path. Export uses the same walk after privacy redaction.

Preflight records each expanded token's origin, source, overridden definition, metadata, immediate and deferred references, and resolved files. Explanation lists deferred targets without descending into them.

## Discovery

Discovery helps callers choose a resource before they retrieve or run it. Exact lookup and discovery stay separate. Discovery never resolves a match, even a unique match.

- Discovery ranks fuzzy matches against the path, description, and tags of each token in the effective view, and against the target of each alias.
- Each search word uses its best match across these fields. Every word must match. Missing or unrelated metadata does not weaken a match in another field.
- With terms, discovery lists project matches first, then shared matches. Each group keeps its relevance order.
- Without terms, discovery lists the project tokens first, then the shared tokens. Each group is in alphabetical order.
- Discovery never reads bodies, evaluates references, or runs scripts. It has no result cap.
- Each candidate has a kind: prompt, alias, or a script runtime. An alias candidate names its target.
