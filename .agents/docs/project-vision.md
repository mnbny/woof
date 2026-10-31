# Woof project vision

This document records how Woof started and where the owner wants Woof to go. It describes the problems that led to Woof, the ideas that shaped it, and the ideas for the future. It is a vision, not a specification. The project brief and the domain and command briefs describe Woof as it is today. The questions brief holds the decisions that are still open.

Update this document only at the owner's request.

## What Woof is for

Woof is a CLI that organizes, finds, composes, and uses the reusable resources of AI assistants and coding agents. These resources are conventions, instructions, ad hoc prompts, project agent instructions, scripts, and snippets.

The goal is one consistent way to reach these resources, even when they are in shared, private, and project-specific locations. With that, a developer or an agent can ask for a resource by name, get the version for the current project, and see where that version came from.

## The problems

### Resource sprawl

Skills, prompts, scripts, and snippets collect in different places and forms. The owner finds, organizes, and maintains them by hand, again and again. In the owner's words:

> “we have skills, prompts, scripts, random snippets. uh its fucking nightmakre”

The problem is larger than finding one document. The owner must know what exists, where the authoritative version is, how to reuse it, and how to make it available in the current project.

### Markdown as the management format

The owner does not accept Markdown as the permanent source format for agent instructions. Markdown documents are difficult to query, maintain, and reuse, and they drift apart.

> “i want conventions and adhoc prompts but i hate managing the markdown aspect”

The prose itself is not the problem. Most values are still instructions in natural language. The change is in how Woof names, structures, composes, and retrieves that prose.

### Rebuilding agent instructions for every project

Every project needs a variation of the same agent instructions and engineering patterns. When work starts on a project, the owner often writes or updates its agent file. Then the owner searches other projects for instructions to copy.

The shared parts are similar, but the differences are important. Copies of whole documents hide these differences and make them difficult to maintain. The owner wants shared pieces with intentional project overrides.

### Resources that cannot be committed

Some prompts, skills, and scripts cannot go into the project repository. They are outside the repository, in ignored folders, or in other locations on the machine. That storage is acceptable. The problem is that the owner loses track of these resources.

Private and external resources are part of the core use case. They are not an edge case.

### Worktrees make it worse

Resources outside the tracked tree are more difficult to find and reuse across worktrees. The owner does not accept copies of the same resources in every worktree. The owner also does not accept a separate project for each worktree. A worktree of a project is still that project.

### Finding the right instruction

A project can have many instructions for similar jobs. A request such as “use Woof to run device verification” does not name an exact resource. If the agent reads every prompt into its context to find the correct one, selective lookup has no value. Native skills solve this problem with a short description of when to use each skill. Woof needs a similar way to choose a resource before it retrieves the resource.

## What came before

### A convention registry

The owner's earliest version of this idea is a skill that applies named conventions from a registry. The owner uses it often, and it works well. The lesson is that named, discoverable, reusable instructions have value. The problems are the maintenance of their Markdown and the work to move the pattern from project to project.

### MAACS prompts

MAACS lets an agent find a requested prompt during a session and apply it. The developer does not need to find the source file. The owner likes this interaction and wants to keep it, without the Markdown maintenance behind it. MAACS is also the reference for shared CLI practice and agent mode. Its prompt and skill catalogs are not part of Woof.

### Design tokens

As a design engineer, the owner used design-system tokens. These definitions refer to other definitions, and a build compiles them into the format that each consumer needs. Woof uses that model, now in the frame of the Design Tokens Community Group format. Raw values become primitives. Aliases name decisions. Larger instructions compose both. Projects act like modes that point the aliases at different values. The consumers are developers and agents. The output is resolved instructions and script results.

## The founding ideas

These ideas shaped Woof from the start.

### Everything is a named token

Resources become named tokens in one structured hierarchy. A token can hold text, point at another token, compose several tokens, or run a script that produces its value. Callers address all tokens in the same way. Common categories, such as conventions and instructions, are conventions and not an allowlist. An ad hoc value, such as the verification steps of a project, is one more token.

### Shared pieces, project overrides

Each shared default exists once. A project overrides only what is different. Composed instructions use the override in every location that refers to it. For example, a shared commit convention can default to seven-rule messages, and one project can change to semantic messages. The agent instructions of that project follow the change. All other projects keep the default. No instructions are copied.

### Projects carry their own context

A project groups its checkouts and worktrees under one context. Woof can recognize the project from the caller's working location, or the caller can name the project. A project can be in the developer's personal Woof home. It can also be in the repository, if the team shares it through Git.

### Resources stay where they belong

The identity of a resource does not depend on its storage location or on whether it can be committed. A definition can be inline, or it can move into a file in any layout. Shared, private, and repository resources all resolve through the same addresses.

### Structured data, still prose inside

Standard JSON is the storage format. It is simple and familiar, and tools can read and write it directly. Instructions stay in natural language inside the JSON. Escaped multiline strings are an accepted trade-off. Tools and skills can do the escaping, so people do not have to.

### Discover before retrieving

Token paths, with optional descriptions and tags, let an agent find candidates without reading their bodies. The agent selects the resource that fits the conversation. Then the agent requests that resource by its exact address. Discovery never runs a resource by itself.

### Small entry points instead of copied files

The agent file of a project can contain only one line that asks Woof for the current instructions. During a session, a developer can say “Claude, please run the Woof Tailwind convention”. The agent then finds the resource, resolves it for the current project, and applies it.

### Explainable results

Each resolved value should be traceable. A caller should be able to see which project applied, which sources and overrides won, which references Woof followed, and which files or scripts took part.

### Sharing without hand repair

A personal project can move to the Woof home of another developer as a portable bundle. There, the project resolves in the same way. Woof shows conflicts and overwrites nothing without an explicit choice. Repository projects move through Git instead.

### Make it real, then make it perfect

> “Let's make it real, then make it perfect.”

Convention over configuration, a useful first version, and simple rules come before completeness.

## What Woof is not

- Not a new Markdown catalog or a copied skill collection.
- Not a framework that needs configuration for each kind of resource.
- Not a hosted service, marketplace, or publishing system.
- Not an LLM client. The agent that is already in the conversation does the reasoning.

## Where it is going

The founding ideas are the base. Next, the owner wants to build toward these ideas, in no fixed order:

- **Companion skills** that help developers and agents discover, use, and maintain Woof resources.
- **Prompt and skill editing workflows** that let people write natural text. Tools then store the text in the structured format.
- **A local browser editor** that runs on the developer's machine, with good Markdown editing for instruction content.
