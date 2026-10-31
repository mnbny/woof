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

- Double braces reference a token. Quadruple braces emit literal double braces once, with no additional lookup.
- References resolve late, against the effective view. For this reason, project overrides apply in all parts of a composition.
- Shared definitions must resolve without a project. They cannot depend on project-only tokens or repository resources.
- A missing target, a namespace target, or a cycle causes a failure. Self-reference is a cycle. It does not reuse a parent value.
- woof never scans script source or script output for references.

## Preflight and provenance

Before any script runs, each resolution walks the complete reachable graph. The walk loads prompt files and checks declared script files. If the walk fails, woof reports the reference chain.

Preflight records the provenance of each reachable token: origin, source, root, overridden definition, metadata, references, and resolved files. Explanation and validation use preflight and do not run scripts.

## Discovery

Discovery helps callers choose a resource before they retrieve or run it. Exact lookup and discovery stay separate. Discovery never resolves a match, even a unique match.

- Discovery ranks fuzzy matches against the path, description, and tags of each token in the effective view, and against the target of each alias.
- Discovery never reads bodies, evaluates references, or runs scripts. It has no result cap.
- Each candidate has a kind: prompt, alias, or a script runtime. An alias candidate names its target.
