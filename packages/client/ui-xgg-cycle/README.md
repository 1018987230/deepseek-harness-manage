---
description: "The xgg-cycle Workspace workflow panel for users managing requirements, prototypes, development, testing, fixes, and deployment through linked Sessions."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-xgg-cycle

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-xgg-cycle` adds a Workspace-scoped project workflow panel to the Web Client. The panel records project information and requirements, expands them into feature groups, and dispatches structured prototype, development, test, fix, and deployment rounds into Sessions. The shipped `web` Profile already includes the package; custom Profiles can install its Bundle layer. Panel data persists in browser storage by Workspace, while Session messages and replies remain authoritative for the work performed by agents.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open **Requirements panel** from a Session header or the sidebar footer. Add project facts and requirements, expand each requirement, confirm the desired feature points, and then run individual phases or the unattended workflow. Dispatching selects the target Session because only an open Session accepts the live events used to detect completion.

### Install into a Profile

The `web` Profile contains this row already. For another compatible Web Profile, install or remove the Bundle and restart the Profile:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-client-ui-xgg-cycle
dsh plugin --profile <name> remove @deepseek-ai/dsh-client-ui-xgg-cycle
```

The Bundle patch inserts the `ui-xgg-cycle` row. Its browser half requires the Session and Workspace controllers, Conversation and Workspace UI services, slot renderer, sidebar, and locale runtime.

### What you get

The panel keeps separate project state for each Workspace. Manual phase actions reuse a live project Session where continuity matters; requirement expansion uses a separate planning Session so it cannot queue behind a long build. The unattended workflow generates feature points, builds a versioned prototype, develops it, and alternates test and fix rounds until no P0/P1 issue remains or five fix rounds complete. Server passwords stay outside browser persistence but enter the durable Session message when direct-server deployment is dispatched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers the same component in `conversation.session.header.utilities` and `sidebar.footer.action`; the root-scoped controller survives Session navigation and owns the persisted store and automatic loop. `session-ask.ts` observes the Session lifecycle and event window until a fresh assistant message or a completed message-less turn settles with an empty queue. The protocol parser scans every JSON code block by expected key so unrelated package or configuration JSON cannot shadow a workflow result.

| File | Responsibility |
|---|---|
| [`src/client/controller.ts`](src/client/controller.ts) | Workspace store, Session dispatch, completion watches, and automatic loop |
| [`src/client/project-model.ts`](src/client/project-model.ts) | Project types, rules, prompt builders, and result application |
| [`src/client/session-ask.ts`](src/client/session-ask.ts) | Session submission, settlement detection, and JSON extraction |
| [`src/client/PopupPanel.tsx`](src/client/PopupPanel.tsx) | Localized workflow presentation and user actions |
| [`cordis.patch.yml`](cordis.patch.yml) | Installable Profile layer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Conversation subsystem](../../../docs/subsystems/conversation.md) — Session-scoped UI assembly and input ownership.
- [Application composition](../../../docs/architecture.md) — Profile and Bundle layering.
- [Slot type chain](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — registration and injected-props rules.

-----

<a id="model-experience"></a>
## Model Experience

### Workflow round messages

#### What the model sees

Each dispatched phase becomes an ordinary user message in the selected Session. The package assembles current project facts, requirements, confirmed feature points, applicable implementation or deployment rules, unresolved manual issues, and a JSON reply contract for the phase. A completed round reports `{"roundComplete":true}` beside its phase result; continuation messages ask the same Session to finish a round that omitted that marker.

#### Token effect

Every dispatch adds the complete assembled phase message to the selected Session and retains the assistant reply. Repeated rounds therefore add their current project ledger and phase-specific instructions again; no hidden prompt section or tool schema is registered.

#### KV Cache effect

Append-only within a reused Session: a follow-up phase extends the existing request prefix. Requirement planning can use a separate Session, and a missing or archived target creates a new Session with no reusable project transcript prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Browser-local project ledger** — requirements, selections, round records, and automatic-loop status do not synchronize between browsers or devices.
- **Navigation during dispatch** — every awaited dispatch opens its Session, so the active conversation changes while the workflow runs.
- **Structured reply dependence** — malformed or missing workflow JSON stops or annotates the round; tolerant extraction does not infer omitted fields.
- **Direct-server credentials enter history** — passwords are excluded from local storage and masked in panel records, but the deployment message is durably logged in its Session.
- **No rollback** — stopping the loop aborts the panel's wait and future rounds; it does not undo files, deployments, or agent work already performed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
