# Agent Note: Workspace project-cycle panel

Status: implemented

English | [中文](2026-09-03-workspace-project-cycle-panel.zh.md)

## Problem

The Web Client exposes Sessions and Workspaces but has no project-level ledger that carries a product request through feature planning, prototyping, development, testing, repair, and deployment. A user can send each instruction manually, but the application cannot preserve the selected feature set, relate later rounds to a prototype version, or continue unattended through test/fix iterations.

## Decision

The optional `@deepseek-ai/dsh-client-ui-xgg-cycle` Bundle contributes one localized workflow panel to both `conversation.session.header.utilities` and `sidebar.footer.action`. The sidebar registration keeps the entry reachable when a blank Session hides conversation chrome. The shipped Web bundle includes the same plugin row, while the package-owned patch lets another compatible Web Profile install it independently.

One browser-persisted store is keyed by Workspace and owns project facts, requirements, confirmed feature groups, prototype and round records, manually reported issues, deployment settings, and automatic-loop state. The root-scoped controller owns the store and every completion watch. Session navigation can therefore unmount a header occupant without cancelling the work it initiated.

Requirement expansion uses a dedicated planning Session. Prototype, development, test, repair, and deployment rounds reuse the latest live project Session when continuity is required, or create a new Workspace Session when no usable target remains. Every awaited dispatch opens the target first because closed Client Session windows do not retain the live events needed for completion detection.

Every phase message requires repository orientation before phase work. The agent reads applicable repository instructions, project documentation and manifests, relevant source and tests, and Git status, then reports the current stack, entry points, implemented behavior, constraints, and remaining gap. Existing implementation takes precedence over new-project defaults, and uncommitted user changes are preserved. Requirement planning has read-only authority; delivery rounds may act only after the orientation identifies the incremental scope. A reused Session may verify that the repository has not changed instead of repeating the full survey.

The session waiter settles only after it observes either a fresh assistant message or a running-to-idle transition, with no queued message remaining. It reads assistant text from the Session event window. Protocol readers scan every parseable JSON payload and select the object carrying the expected key, so source files or configuration examples in the same answer cannot shadow the workflow result.

The unattended path generates features, creates a versioned prototype, starts formal development, and alternates test and repair rounds. It stops successfully when no actionable P0/P1 issue remains and stops with a bounded result after five repair rounds. A browser reload turns an orphaned busy state into an explicit stopped state rather than implying that an in-memory controller is still running.

Direct-server passwords are excluded from browser persistence and masked in the panel's dispatch record. The deployment message still contains the password and becomes durable Session history; the panel states that consequence before dispatch.

## Alternatives considered

**Keep the loop inside `PopupPanel`.** Rejected because opening a dispatch target changes the selected Session and can unmount the session-header occupant. Component-owned state and waits would disappear during their own first dispatch.

**Use one Session for requirement expansion and project implementation.** Rejected because an expansion submitted during a long implementation turn would queue behind it, while completion watchers could associate the wrong turn with a round. Planning and implementation have different continuity requirements.

**Rely on manually entered Basic Information as the project description.** Rejected because free-form fields cannot reliably describe existing modules, repository instructions, local changes, tests, or work completed outside the panel. The agent reads those facts from the Workspace before interpreting the requested increment.

**Treat the first parseable JSON block as the result.** Rejected because implementation replies commonly contain valid `package.json`, configuration, or other JSON blocks. Each parser must identify its own keyed object.

**Persist deployment passwords with the rest of the project.** Rejected because convenience does not justify retaining a reusable secret in browser storage. The Session-history exposure remains explicit because deployment cannot occur without transmitting the credential to the selected agent.

## Consequences

The Web Client gains a continuous project workflow without adding a Host service or changing the agent loop. Existing repositories are treated as current projects rather than empty scaffolds, at the cost of additional repository reads, orientation text, and summary tokens on each dispatched phase. It also pays for a large browser bundle, Workspace-local state that does not synchronize across devices, active Session navigation during dispatch, and strict dependence on structured phase replies. Stopping the controller prevents later rounds but cannot roll back files or deployments already changed by an agent.

The package owns model-visible user messages even though it is implemented in the browser. Its README records their token and KV-cache effects, and its locale dictionaries own presentation copy separately from the Chinese workflow prompts.
