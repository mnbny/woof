# Sharing domain

## Portable archives

Export requires an explicitly registered home project; repository-defined projects cannot transfer. A standard ZIP has no manifest. Root `woof.config.json` identifies one selected project and the inherited shared definitions it needs. Other project entries are pruned only in the payload.

Archives preserve project overrides, metadata, referenced JSON, and raw payload bytes at root-relative paths. Independent root and selected graphs validate without script execution. Application checkouts are not copied. Project `<repo>` requirements remain external and require normal target-checkout validation.

Archive input and expanded data are capped at 100 MiB each and 10,000 entries. Paths reject traversal, special devices, nonportable forms, and Unicode/case collisions. Extra files and central/local name, size, or CRC mismatches reject.

## Review and ownership

Import merges root and selected-project leaves per dotted token path, with explicit metadata and storage choices. Raw prompt/script files conflict as whole files; identical bytes need no decision. Unrelated local tokens and projects remain.

Occupied or shared project-config destinations and registered config paths used by raw payloads reject nonidentical changes, including physical aliases. Unchanged selected data and byte-identical final JSON are no-write exceptions. Relocation, deletion, and cross-project merging are not automatic.

When shared definitions or existing resource bytes change, candidate validation also covers other available home/inline projects with source snapshots and named failures. Repo-based views remain deferred. Pure selected-project additions need no extra traversal.

## Decisions and recovery

Review presents one conflict and diff at a time. Agents and non-TTY humans receive an exit-1 decisions handoff; actual Clack cancellation exits 130. Decisions JSON binds the archive digest and complete conflict metadata. Accepted `keep`/`take` choices persist while `next` identifies the unresolved conflict without preselecting it. Unchanged handoffs cannot apply, including on the last conflict.

Complete choices trigger final validation, source rechecks, staged application, and root-registry-last replacement. Prepared migrations apply with that import rather than during review. Original bytes and modes support ordinary-failure rollback and retained recovery artifacts; multi-file crash atomicity is not promised.
