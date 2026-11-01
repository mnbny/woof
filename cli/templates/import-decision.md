Review {{kind}} {{path}}

{{diff}}{{notice}}{{reusable}}{{rechecks}}

Import needs the user's decision for this item. No import files change until every item has a decision.

{{document}}

Set choices[next.id] to the choice that the user makes:

- "take": use the archive's version. It replaces the local item.
- "keep": keep the local item and skip the archive's version.
- {"action":"add","address":"..."}: import it at a new address or path, and keep the local item.
- {"action":"reuse","address":"..."}: use an identical local item instead of importing it.

Save the file and run woof import {{archive}} --decisions {{decisions}} --agent.
