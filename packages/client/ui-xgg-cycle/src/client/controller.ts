/**
 * The panel's root-scope brain: one persisted store keyed by Workspace, plus
 * the automatic loop that drives a project through its lifecycle.
 *
 * Why this is not in the component. Two facts forced it:
 *   1. A session whose window was never opened drops live events
 *      (Session.acceptLiveEvent bails while openState !== 'open'), and the only
 *      exposed way to open one is `sessions.open`, which also SELECTS it. So a
 *      dispatch that waits for a reply must navigate.
 *   2. The panel is also registered into a session-scope slot, so navigating
 *      unmounts that copy of it.
 * A loop living in the component would therefore kill itself on its first
 * dispatch. Here it survives, and the component is a pure view over the store.
 *
 * Keyed by Workspace because a Workspace is the project: one directory, one set
 * of requirements, feature points, prototype versions and bugs.
 */
import {
  type Context,
} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import {
  parseCompletedPoints, parseExpansion, parseFixOutcome, parseReport, parseRoundComplete,
} from './loop-protocol.ts'
import {
  buildDevelopContext, buildExpandPrompt, buildFixContext, buildPrototypeContext,
  applyDevelopOutcome, applyFixOutcome, buildTestContext, BUSY_STAGES, continuePrompt,
  EMPTY_SERVER, expandProbePrompt, harvestProbePrompt, IDLE_LOOP, MAX_FIX_ROUNDS, mergeBugs,
  isActionableBug, nextId, probePrompt, projectSession, toModuleGroups,
  type BugItem, type HandOffRecord, type InfoEntry, type LoopState, type ModuleGroup,
  type PrototypeMode, type ReleaseTarget, type Requirement, type RequirementGroup,
  type ServerConfig,
} from './project-model.ts'
import { askSession, awaitSessionTurn } from './session-ask.ts'

/** localStorage name of the whole panel store. */
const STORE_NAME = 'xgg-cycle.panel'

/** Project key used when no Workspace exists yet (sessions outside any project). */
const NO_WORKSPACE = '__none__'

/**
 * Turns one round may span before the loop stops nudging it.
 *
 * A round legitimately takes several: a build gets interrupted and has to be
 * told 继续. The cap only stops an endless "not done yet" from spinning.
 */
const MAX_ROUND_TURNS = 10

/** Everything one project remembers. */
export interface ProjectState {
  requirements: Requirement[]
  groups: RequirementGroup[]
  info: InfoEntry[]
  records: HandOffRecord[]
  bugs: BugItem[]
  mode: PrototypeMode
  releaseTarget: ReleaseTarget
  server: ServerConfig
  /** Per-phase append-box text, keyed by the phase that owns it. */
  extras: Record<'prototype' | 'develop' | 'test' | 'release', string>
  /**
   * The requirement-planning session, kept apart from the build session.
   *
   * Expansion is the one round whose context is fully reconstructible from
   * this store (基础信息 + 已有功能点 + the new requirement), so it does not
   * need the build transcript — and must not share it: a build round holds
   * that session for many minutes, and an expansion submitted there queues
   * behind it while the build's own completion watch mistakes the expansion's
   * turn for its own.
   */
  planSessionId: string
  loop: LoopState
}

/** The whole store: every project, plus which one the shell is looking at. */
export interface PanelState {
  activeKey: string
  projects: Record<string, ProjectState>
}

/**
 * A fresh project.
 * @returns the empty project state.
 */
function emptyProject(): ProjectState {
  return {
    requirements: [], groups: [], info: [], records: [], bugs: [],
    mode: 'simple', releaseTarget: 'cloudflare', server: { ...EMPTY_SERVER },
    extras: { prototype: '', develop: '', test: '', release: '' },
    planSessionId: '',
    loop: { ...IDLE_LOOP, steps: [] },
  }
}

/** The verbs the view drives the panel through. */
export interface PanelController {
  readonly store: ObservableSnapshot<PanelState>
  /** The project the shell is currently looking at. */
  project(): ProjectState
  /** Mutate the active project through an immer draft. */
  update(mutate: (draft: ProjectState) => void): void
  /** Manual dispatch: deliver, select the session, and return its id. */
  handOff(text: string, sessionId?: string): Promise<string>
  /**
   * Follow a fire-and-forget round and mark it 已完成 when its turn ends.
   * @param recordId - the record to settle.
   * @param sessionId - the session running that round.
   */
  trackRecord(recordId: string, sessionId: string): void
  /**
   * Resume a round that reported a turn without declaring itself finished.
   * @param recordId - the round to resume.
   */
  continueRound(recordId: string): Promise<void>
  /** Expand one requirement into candidate modules (the 扩展需求 button). */
  expandOne(requirementId: string): Promise<void>
  /**
   * The whole unattended run: 功能点 → 原型 → 正式开发 → test/fix rounds,
   * straight through, until clean or MAX_FIX_ROUNDS.
   */
  runToPrototype(): void
  /**
   * Resume from 正式开发 with the prototype already built — the recovery entry
   * for a run that died after it landed, not a gate.
   */
  runFromDevelop(): void
  stopLoop(): void
  dismissLoop(): void
  isSessionLive(sessionId: string): boolean
  /** Tear down the workspace-tracking subscriptions. */
  dispose(): void
}

/**
 * Resolve the Workspace acting as the current project.
 * @param ctx - client root context.
 * @returns the workspace id, or undefined when there is none.
 */
function activeWorkspace(ctx: Context): WorkspaceId | undefined {
  const { items } = ctx.workspaces.list.getSnapshot()
  const sessions = ctx.sessions.list.getSnapshot()
  const current = sessions.current
  const owning = current === undefined
    ? undefined
    : items.find(item => item.sessionIds.includes(current))?.workspaceId
  if (owning !== undefined) return owning
  let recent: WorkspaceId | undefined
  let recentTime = Number.NEGATIVE_INFINITY
  for (const item of items) {
    let latest = Date.parse(item.createdAt)
    for (const sessionId of item.sessionIds) {
      const summary = sessions.byId[sessionId]
      if (summary !== undefined) latest = Math.max(latest, summary.updatedAt)
    }
    if (recent === undefined || latest > recentTime) {
      recent = item.workspaceId
      recentTime = latest
    }
  }
  return recent
}

/**
 * Build the panel controller and start tracking which project is active.
 * @param ctx - client root context.
 * @returns the controller.
 */
export function createPanelController(ctx: Context): PanelController {
  const store = createSnapshotStore<PanelState>(
    { activeKey: NO_WORKSPACE, projects: {} },
    { persist: { name: STORE_NAME } },
  )
  let abort: AbortController | null = null
  // Every in-flight completion watch, keyed by the record it settles, so
  // dispose() can cut them all loose and 继续 can tell whether one is still
  // listening before it re-arms.
  const watches = new Map<string, AbortController>()

  // The store persists the loop's stage, but the loop itself is a JS closure —
  // a page reload (or a plugin reload) leaves the stage saying "testing" with
  // nothing running behind it. Settle every such orphan on boot so the banner
  // tells the truth and offers the restart controls instead of a phantom stop.
  store.update((draft) => {
    for (const entry of Object.values(draft.projects)) {
      if (!BUSY_STAGES.includes(entry.loop.stage)) continue
      entry.loop.stage = 'stopped'
      entry.loop.message = '页面重载中断了自动流程。会话里那一轮可能已经跑完，去看一眼，然后从对应阶段手动继续。'
      for (const item of entry.loop.steps) {
        if (item.status === 'running') {
          item.status = 'failed'
          item.detail = '页面重载时中断'
        }
      }
    }
  })

  const ensure = (draft: PanelState, key: string): ProjectState => {
    draft.projects[key] ??= emptyProject()
    // Non-null: the line above guarantees it, and immer hands back the draft.
    return draft.projects[key]
  }

  const syncActive = () => {
    const workspaceId = activeWorkspace(ctx)
    const key = workspaceId ?? NO_WORKSPACE
    if (store.getSnapshot().activeKey === key && store.getSnapshot().projects[key] !== undefined) return
    store.update((draft) => {
      draft.activeKey = key
      ensure(draft, key)
    })
  }
  syncActive()
  const offSessions = ctx.sessions.list.subscribe(syncActive)
  const offWorkspaces = ctx.workspaces.list.subscribe(syncActive)

  const project = (): ProjectState => {
    const state = store.getSnapshot()
    return state.projects[state.activeKey] ?? emptyProject()
  }
  const update = (mutate: (draft: ProjectState) => void) => {
    store.update((draft) => { mutate(ensure(draft, draft.activeKey)) })
  }
  /** Mutate one specific project — the loop pins its key so a mid-run
   * Workspace switch cannot redirect its writes into another project. */
  const updateKeyed = (key: string, mutate: (draft: ProjectState) => void) => {
    store.update((draft) => { mutate(ensure(draft, key)) })
  }
  const setLoop = (key: string, mutate: (draft: LoopState) => void) => {
    updateKeyed(key, (draft) => { mutate(draft.loop) })
  }

  /**
   * Fold a settled round's structured result back onto the board.
   *
   * The two harvests that close the automation loop: a 测试 round's problems,
   * and a 修复 round's verdict on the ones it was given. Everything else just
   * settles its status.
   * @param draft - the project being mutated.
   * @param record - the round that settled.
   * @param reply - the turn that declared completion.
   */
  /**
   * Whether a reply already carries the structured result its kind harvests.
   *
   * Checked independently of the completion marker: a round that emits only
   * `{"roundComplete": true}` — the exact shape the marker contract asks for —
   * is finished and yet has told us nothing to fold back. The marker and the
   * data are separate promises, and a round routinely keeps only the first.
   * @param kind - the round's kind.
   * @param reply - the assistant text.
   * @returns true when the harvest can proceed, or the kind harvests nothing.
   */
  const hasHarvest = (kind: HandOffRecord['kind'], reply: string): boolean => {
    if (kind === 'develop') return parseCompletedPoints(reply) !== undefined
    if (kind === 'test') return parseReport(reply) !== undefined
    if (kind === 'fix') return parseFixOutcome(reply) !== undefined
    return true
  }

  const harvestRound = (draft: ProjectState, record: HandOffRecord, reply: string) => {
    if (record.kind === 'develop') {
      const names = parseCompletedPoints(reply)
      if (names === undefined) {
        record.note = '未报告完成的功能点，功能点状态未更新'
        return
      }
      const applied = applyDevelopOutcome(draft.groups, names, record.baseVersion)
      draft.groups = applied.groups
      const parts = [`功能点完成 ${applied.done} 个`]
      if (applied.unmatched > 0) parts.push(`${applied.unmatched} 个名字对不上`)
      record.note = parts.join('，')
      return
    }
    if (record.kind === 'test') {
      const report = parseReport(reply)
      if (report === undefined) {
        record.note = '报告未能解析，问题未回填'
        return
      }
      const merged = mergeBugs(draft.bugs, report.bugs)
      draft.bugs = merged.bugs
      record.note = merged.added === 0 && merged.reopened === 0
        ? '未发现新问题'
        : `回填 ${merged.added} 个新问题${merged.reopened === 0 ? '' : `，重开 ${merged.reopened} 个`}`
      return
    }
    if (record.kind !== 'fix') return
    const outcome = parseFixOutcome(reply)
    if (outcome === undefined) {
      // Left in 修复中 on purpose: claiming either outcome without being told
      // would be a guess, and the row's note says so.
      record.note = '修复结果未能解析，问题状态未回填'
      return
    }
    const applied = applyFixOutcome(draft.bugs, outcome)
    draft.bugs = applied.bugs
    const parts = [`修好 ${applied.fixed} 个`]
    if (applied.unfixed > 0) parts.push(`未修好 ${applied.unfixed} 个`)
    if (applied.unmatched > 0) parts.push(`${applied.unmatched} 条标题对不上`)
    record.note = parts.join('，')
  }

  /**
   * The project's requirement-planning session, remembered across expansions.
   *
   * Deliberately not the build session: an expansion sent there would queue
   * behind a running build round and only answer once it finished, which is
   * exactly the "can't expand while developing" dead end. A stale id (archived
   * or deleted session) resolves to undefined so the dispatch opens a new one.
   * @param entry - the project.
   * @returns the planning session, or undefined when there is none to reuse.
   */
  const planSession = (entry: ProjectState): string | undefined =>
    entry.planSessionId !== '' && isSessionLive(entry.planSessionId)
      ? entry.planSessionId
      : undefined

  const isSessionLive = (sessionId: string): boolean =>
    ctx.sessions.binding(sessionId as SessionId) !== undefined

  const createSession = async (): Promise<SessionId> => {
    const target = activeWorkspace(ctx)
    if (target === undefined) throw new Error('没有可用的工作区，无法新建会话')
    return ctx.uiWorkspace.connectWorkspace(target)
  }

  const resolveTarget = async (sessionId?: string): Promise<SessionId> => {
    const requested = sessionId === undefined ? undefined : sessionId as SessionId
    const live = requested !== undefined && isSessionLive(requested)
    return live ? requested : createSession()
  }

  /**
   * Resolve the target session and select it.
   *
   * Selecting is not cosmetic here: it is what opens the session's window, and
   * a session whose window is closed silently drops the very reply the loop is
   * waiting for (Session.acceptLiveEvent bails while openState !== 'open').
   */
  const openTarget = async (sessionId?: string): Promise<SessionId> => {
    const target = await resolveTarget(sessionId)
    ctx.sessions.open(target)
    return target
  }

  const handOff = async (text: string, sessionId?: string): Promise<string> => {
    const target = await openTarget(sessionId)
    const actx = ctx.sessions.scope(target)
    if (actx === undefined) throw new Error(`会话 ${target} 没有解析出会话作用域`)
    const conversation = actx.get('conversation')
    if (conversation === undefined) throw new Error('会话服务不可用，无法投递上下文')
    const input = conversation.input.for(actx)
    input.setDraft(text)
    input.submit()
    return target
  }

  const ask = async (
    text: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ sessionId: SessionId; reply: string }> => {
    const target = await openTarget(sessionId)
    const reply = await askSession(ctx, target, text, signal)
    return { sessionId: target, reply }
  }

  /**
   * Watch one dispatched round and settle its status when the turn ends.
   *
   * This lives here rather than in the component for the same reason the loop
   * does: the dispatch that started the round also selected its session, which
   * unmounts the session-scoped copy of the panel — a watch owned by the view
   * would die before it could ever fire.
   */
  /**
   * The phase noun a round's copy is written in.
   * @param kind - the round's kind.
   * @returns the noun.
   */
  const nounOf = (kind: HandOffRecord['kind']): string => kind === 'prototype'
    ? '原型'
    : kind === 'develop'
      ? '开发'
      : kind === 'test' ? '测试' : kind === 'fix' ? '修复' : '上线'

  const trackRecord = (recordId: string, sessionId: string) => {
    const key = store.getSnapshot().activeKey
    // One watch per record: a re-arm while the first is still listening would
    // otherwise settle (and harvest) the same round twice.
    if (watches.has(recordId)) return
    const controller = new AbortController()
    watches.set(recordId, controller)
    const recordOf = () => store.getSnapshot().projects[key]?.records.find(item => item.id === recordId)

    void (async () => {
      try {
        let turns = 0
        while (turns < MAX_ROUND_TURNS) {
          let reply: string
          try {
            reply = await awaitSessionTurn(ctx, sessionId as SessionId, controller.signal)
          } catch (error: unknown) {
            if (controller.signal.aborted) return
            // A stalled turn timed out. The round is not over, so neither is
            // this watch: the user will nudge it with 继续 and the next turn
            // must still find someone listening.
            if (error instanceof Error && error.message.includes('超时')) continue
            throw error
          }
          turns += 1
          // A status the user moved by hand is their judgement — stop following.
          const kind = recordOf()?.kind
          if (kind === undefined || recordOf()?.status !== 'active') return

          // The marker at the end of a long build prompt is routinely
          // forgotten, and so is the structured result. Rather than trust
          // recall, ask: one short question with one allowed answer shape.
          if (!parseRoundComplete(reply)) {
            turns += 1
            const probe = await ask(probePrompt(kind, nounOf(kind)), sessionId, controller.signal)
            // Still not done: it really is mid-work. Wait for the user's 继续.
            if (!parseRoundComplete(probe.reply)) continue
            reply = probe.reply
          }
          // Complete, but the structured result may still be missing — the
          // marker and the data are separate promises and a round routinely
          // keeps only the first.
          if (!hasHarvest(kind, reply)) {
            const dataProbe = harvestProbePrompt(kind, nounOf(kind))
            if (dataProbe !== undefined) {
              turns += 1
              const probe = await ask(dataProbe, sessionId, controller.signal)
              if (hasHarvest(kind, probe.reply)) reply = probe.reply
            }
          }
          updateKeyed(key, (draft) => {
            const record = draft.records.find(item => item.id === recordId)
            if (record === undefined || record.status !== 'active') return
            record.status = 'done'
            harvestRound(draft, record, reply)
          })
          return
        }
      } catch {
        // Anything else: leave the round 进行中 for the user to judge.
      } finally {
        if (watches.get(recordId) === controller) watches.delete(recordId)
      }
    })()
  }

  /**
   * Nudge one still-running round to finish (the panel's 继续 button).
   *
   * Re-arms the completion watch when none is listening: the original one may
   * have run out its turn budget or been lost to a reload, and a 继续 whose
   * marker nobody reads would leave the round 进行中 forever.
   * @param recordId - the round to resume.
   * @returns settlement of the dispatch.
   */
  const continueRound = async (recordId: string): Promise<void> => {
    const record = project().records.find(item => item.id === recordId)
    if (record === undefined) return
    await handOff(continuePrompt(nounOf(record.kind)), record.sessionId)
    trackRecord(recordId, record.sessionId)
  }

  /**
   * Dispatch a round and see it through to its declared end.
   *
   * `ask` resolves at the first TURN boundary, which is not the round's end —
   * an interrupted build reports a turn and waits to be told 继续. Returning
   * there would let the loop test a half-built project, so this keeps nudging
   * until the round says it is complete (or the cap is hit).
   * @param noun - phase noun used in the continuation message.
   * @param text - the round's opening message.
   * @param sessionId - session to run it in.
   * @param signal - aborts the whole round.
   * @returns the session used, the final reply, and whether it declared completion.
   */
  const askRound = async (
    kind: HandOffRecord['kind'],
    text: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ sessionId: string; reply: string; complete: boolean }> => {
    const noun = nounOf(kind)
    /** Once a round is done, make sure its structured result came with it. */
    const withHarvest = async (
      settled: { sessionId: string; reply: string },
    ): Promise<{ sessionId: string; reply: string; complete: boolean }> => {
      if (hasHarvest(kind, settled.reply)) return { ...settled, complete: true }
      const dataProbe = harvestProbePrompt(kind, noun)
      if (dataProbe === undefined) return { ...settled, complete: true }
      const probe = await ask(dataProbe, settled.sessionId, signal)
      return hasHarvest(kind, probe.reply)
        ? { sessionId: probe.sessionId, reply: probe.reply, complete: true }
        : { ...settled, complete: true }
    }

    let result = await ask(text, sessionId, signal)
    for (let turn = 1; turn < MAX_ROUND_TURNS; turn += 1) {
      if (parseRoundComplete(result.reply)) return withHarvest(result)
      // Same reason as the manual watch: a round that finished but forgot the
      // marker is indistinguishable from one still working, so ask instead of
      // assuming — and the probe's answer carries the structured result too.
      const probe = await ask(probePrompt(kind, noun), result.sessionId, signal)
      if (parseRoundComplete(probe.reply)) return withHarvest(probe)
      result = await ask(continuePrompt(noun), probe.sessionId, signal)
    }
    return {
      sessionId: result.sessionId,
      reply: result.reply,
      complete: parseRoundComplete(result.reply),
    }
  }

  const beginStep = (key: string, label: string): string => {
    const id = nextId('ls')
    setLoop(key, (loop) => {
      loop.steps.push({ id, label, status: 'running', detail: '', at: Date.now() })
    })
    return id
  }
  const endStep = (key: string, id: string, status: 'ok' | 'failed', detail: string) => {
    setLoop(key, (loop) => {
      const step = loop.steps.find(item => item.id === id)
      if (step !== undefined) {
        step.status = status
        step.detail = detail
      }
    })
  }
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)

  /** Run one loop step, marking its log line either way. */
  const step = async <T>(key: string, label: string, run: () => Promise<T>, detail: (value: T) => string): Promise<T> => {
    const id = beginStep(key, label)
    try {
      const value = await run()
      endStep(key, id, 'ok', detail(value))
      return value
    } catch (error: unknown) {
      endStep(key, id, 'failed', reason(error))
      throw error
    }
  }

  const failLoop = (key: string, error: unknown) => {
    const text = reason(error)
    // A deliberate stop already wrote its own message; do not overwrite it.
    if (text === '已取消') return
    setLoop(key, (loop) => {
      loop.stage = 'failed'
      loop.message = `流程中断：${text}`
    })
  }

  /**
   * Expand one requirement into candidate modules.
   *
   * Progress and failure land in the store, not in the caller: the dispatch
   * selects its session, which unmounts the session-scoped copy of the panel,
   * so a rejection handled there would be written into a dead component and
   * the button would silently return to its idle label with no reason given.
   * @param requirementId - the requirement to expand.
   */
  const expandOne = async (requirementId: string): Promise<void> => {
    const key = store.getSnapshot().activeKey
    const state = project()
    const target = state.requirements.find(item => item.id === requirementId)
    if (target === undefined) return

    const mark = (mutate: (item: Requirement) => void) => {
      updateKeyed(key, (draft) => {
        const item = draft.requirements.find(entry => entry.id === requirementId)
        if (item !== undefined) mutate(item)
      })
    }
    mark((item) => {
      item.expanding = true
      delete item.error
    })

    const controller = new AbortController()
    watches.set(`expand:${requirementId}`, controller)
    try {
      // Expand inside the project's own session, and tell it what already
      // exists: a fresh session knew none of the earlier requirements, so a
      // requirement added later was expanded in a vacuum.
      let { reply, sessionId: used } = await ask(
        buildExpandPrompt(state.info, [target], state.groups),
        planSession(state),
        controller.signal,
      )
      updateKeyed(key, (draft) => { draft.planSessionId = used })
      let first = parseExpansion(reply)[0]
      if (first === undefined) {
        // Same principle as the round probe: ask again, short and strict,
        // rather than failing on a format slip.
        const probe = await ask(expandProbePrompt(), used, controller.signal)
        reply = probe.reply
        used = probe.sessionId
        first = parseExpansion(reply)[0]
      }
      if (first === undefined) {
        mark((item) => {
          item.expanding = false
          item.error = '会话没有给出可解析的功能点 json（连追问也没有）。去那条会话看看它回了什么，或者把需求描述得具体一些再试。'
        })
        return
      }
      const modules = toModuleGroups(first.modules)
      mark((item) => {
        item.expanding = false
        item.expanded = true
        item.modules = modules
        delete item.error
      })
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      mark((item) => {
        item.expanding = false
        item.error = `扩展失败：${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      if (watches.get(`expand:${requirementId}`) === controller) {
        watches.delete(`expand:${requirementId}`)
      }
    }
  }

  const runToPrototype = (): void => {
    const key = store.getSnapshot().activeKey
    const controller = new AbortController()
    abort = controller
    void (async () => {
      try {
        const start = project()
        if (start.requirements.length === 0) {
          setLoop(key, (loop) => {
            loop.stage = 'failed'
            loop.message = '先在「需求」里加至少一条需求。'
          })
          return
        }
        const version = start.records
          .filter(record => record.kind === 'prototype')
          .reduce((max, record) => Math.max(max, record.version), 0) + 1
        setLoop(key, (loop) => {
          Object.assign(loop, { ...IDLE_LOOP, steps: [], stage: 'expanding', version, message: '正在生成功能点…' })
        })

        const pending = start.requirements.filter(item => item.modules.length === 0)
        if (pending.length > 0) {
          await step(key, `生成功能点（${pending.length} 条需求）`, async () => {
            const expansion = await ask(
              buildExpandPrompt(start.info, pending, start.groups),
              planSession(start),
              controller.signal,
            )
            const { reply } = expansion
            updateKeyed(key, (draft) => { draft.planSessionId = expansion.sessionId })
            const parsed = parseExpansion(reply)
            if (parsed.length === 0) throw new Error('回复里没有可解析的功能点 json')
            const byId = new Map<string, ModuleGroup[]>()
            let added = 0
            for (const entry of parsed) {
              const source = pending[entry.index - 1]
              if (source === undefined) continue
              const modules = toModuleGroups(entry.modules)
              byId.set(source.id, modules)
              for (const mod of modules) added += mod.points.length
            }
            if (byId.size === 0) throw new Error('回复里的 index 对不上任何一条需求')
            // The automatic run accepts every generated point; the 功能点 phase
            // stays fully editable afterwards.
            updateKeyed(key, (draft) => {
              for (const item of draft.requirements) {
                const modules = byId.get(item.id)
                if (modules === undefined) continue
                item.expanded = true
                item.modules = modules
                draft.groups = draft.groups.filter(group => group.reqId !== item.id)
                draft.groups.push({ reqId: item.id, reqText: item.text, modules })
              }
            })
            return { count: byId.size, added }
          }, value => `${value.count} 条需求，共 ${value.added} 个功能点`)
        }

        setLoop(key, (loop) => {
          loop.stage = 'prototyping'
          loop.message = `正在生成原型 v${version}…`
        })
        const ready = project()
        // Same rule as the manual button: iterate inside the session earlier
        // versions were built in, so v2 is a revision of v1 rather than a
        // from-scratch rebuild that drifts.
        const continueIn = projectSession(ready.records, isSessionLive)
        const content = buildPrototypeContext(
          ready.info, ready.requirements, ready.groups, ready.mode, ready.extras.prototype, version,
          continueIn !== undefined, ready.records,
        )
        const sessionId = await step(key, `生成原型 v${version}`, async () => {
          const result = await askRound('prototype', content, continueIn, controller.signal)
          updateKeyed(key, (draft) => {
            draft.records.unshift({
              id: nextId('ph'), kind: 'prototype', version, mode: ready.mode,
              createdAt: Date.now(), sessionId: result.sessionId, status: 'done', content,
            })
          })
          return result.sessionId
        }, () => '原型会话已产出')

        setLoop(key, (loop) => { loop.sessionId = sessionId })
        // Straight on. The run is unattended by design, so there is no gate
        // here: the prototype is a stage of the same project, in the same
        // session, and development revises it rather than starting over.
        await develop(key, sessionId, version, controller)
      } catch (error: unknown) {
        failLoop(key, error)
      } finally {
        abort = null
      }
    })()
  }

  /**
   * 正式开发 → test/fix rounds, run to convergence.
   *
   * Reached straight from the prototype stage in an unattended run, and reused
   * as the resume entry when a run died after the prototype was already built.
   * @param key - the pinned project key.
   * @param sessionId - the project session every round continues in.
   * @param version - the 原型 version these rounds are built against.
   * @param controller - the run's abort controller.
   */
  const develop = async (
    key: string,
    sessionId: string,
    version: number,
    controller: AbortController,
  ): Promise<void> => {
    {
      {
        setLoop(key, (loop) => {
          loop.stage = 'developing'
          loop.message = '正在正式开发…'
        })
        const dev = project()
        const devContent = buildDevelopContext(
          dev.info, dev.requirements, dev.groups, dev.extras.develop, false, version, 1, dev.records,
        )
        await step(key, '正式开发 第 1 轮', async () => {
          const outcome = await askRound('develop', devContent, sessionId, controller.signal)
          if (!outcome.complete) {
            throw new Error(`开发跑满 ${MAX_ROUND_TURNS} 个回合仍未声明完成 —— 去那条会话里看看卡在哪，不要让测试基于半成品继续`)
          }
          let note = ''
          updateKeyed(key, (draft) => {
            const record: HandOffRecord = {
              id: nextId('dh'), kind: 'develop', version: 1, baseVersion: version,
              createdAt: Date.now(), sessionId, status: 'done', content: devContent,
            }
            harvestRound(draft, record, outcome.reply)
            draft.records.unshift(record)
            note = record.note ?? ''
          })
          return note
        }, note => note)

        // Round 1 carries whatever the user filed by hand; later rounds carry
        // the problems the previous round was asked to fix, so the next test
        // re-verifies exactly those.
        let carry: BugItem[] = project().bugs.filter(isActionableBug)
        for (let round = 1; round <= MAX_FIX_ROUNDS; round += 1) {
          setLoop(key, (loop) => {
            loop.stage = 'testing'
            loop.round = round
            loop.message = `正在自动测试 第 ${round} 轮…`
          })
          const now = project()
          const testContent = buildTestContext(
            now.info, now.requirements, now.groups, now.extras.test, false, version, round, carry, now.records,
          )
          const blocking = await step(key, `自动测试 第 ${round} 轮`, async () => {
            const { reply, complete } = await askRound('test', testContent, sessionId, controller.signal)
            if (!complete) throw new Error(`测试跑满 ${MAX_ROUND_TURNS} 个回合仍未声明完成`)
            const report = parseReport(reply)
            // A missing json block is NOT read as "zero bugs": ending the loop
            // on a formatting slip would be the worst failure mode here.
            if (report === undefined) throw new Error('测试报告里没有可解析的 json 块，无法判断是否还有问题')
            let harvested: BugItem[] = []
            updateKeyed(key, (draft) => {
              const merged = mergeBugs(draft.bugs, report.bugs)
              draft.bugs = merged.bugs
              harvested = merged.bugs.filter(bug => report.bugs.some(item => item.title === bug.title))
              draft.records.unshift({
                id: nextId('th'), kind: 'test', version: round, baseVersion: version,
                createdAt: Date.now(), sessionId, status: 'done', content: testContent,
                note: merged.added === 0 && merged.reopened === 0
                  ? '未发现新问题'
                  : `回填 ${merged.added} 个新问题${merged.reopened === 0 ? '' : `，重开 ${merged.reopened} 个`}`,
              })
            })
            return harvested.filter(bug => bug.severity !== 'P2')
          }, value => `P0/P1 ${value.length} 个`)

          if (blocking.length === 0) {
            setLoop(key, (loop) => {
              loop.stage = 'done'
              loop.message = `第 ${round} 轮测试已无 P0/P1 问题，自动流程结束。剩下的 P2 在「测试」页，自己决定要不要修。`
            })
            return
          }
          if (round === MAX_FIX_ROUNDS) {
            setLoop(key, (loop) => {
              loop.stage = 'stopped'
              loop.message = `已跑满 ${MAX_FIX_ROUNDS} 轮上限，仍有 ${blocking.length} 个 P0/P1。去「测试」页勾选后手动继续。`
            })
            return
          }

          setLoop(key, (loop) => {
            loop.stage = 'fixing'
            loop.message = `正在修复 第 ${round} 轮（${blocking.length} 条）…`
          })
          const fixContent = buildFixContext(blocking, round, version)
          await step(key, `修复 第 ${round} 轮（${blocking.length} 条）`, async () => {
            const outcome = await askRound('fix', fixContent, sessionId, controller.signal)
            if (!outcome.complete) {
              throw new Error(`修复跑满 ${MAX_ROUND_TURNS} 个回合仍未声明完成 —— 去那条会话里看看卡在哪`)
            }
            const dispatched = new Set(blocking.map(bug => bug.id))
            let note = ''
            updateKeyed(key, (draft) => {
              for (const bug of draft.bugs) {
                if (dispatched.has(bug.id)) bug.status = 'fixing'
              }
              const record: HandOffRecord = {
                id: nextId('fh'), kind: 'fix', version: round, baseVersion: version,
                createdAt: Date.now(), sessionId, status: 'done', content: fixContent,
              }
              // Folds the round's verdict onto the board. Without it every
              // dispatched problem stays 修复中 and the board can never reach
              // clean, so the loop could never decide it was done.
              harvestRound(draft, record, outcome.reply)
              draft.records.unshift(record)
              note = record.note ?? ''
            })
            return note
          }, note => note)
          carry = blocking
        }
      }
    }
  }

  /**
   * Resume the run from 正式开发, reusing an already-built prototype.
   *
   * Not a gate — the unattended run never stops here. This is the recovery
   * entry for a run that died after the prototype landed, so retrying does not
   * rebuild it.
   */
  const runFromDevelop = (): void => {
    const key = store.getSnapshot().activeKey
    const entry = project()
    const sessionId = entry.loop.sessionId
    const version = entry.loop.version
    if (sessionId === '') return
    const controller = new AbortController()
    abort = controller
    void (async () => {
      try {
        await develop(key, sessionId, version, controller)
      } catch (error: unknown) {
        failLoop(key, error)
      } finally {
        abort = null
      }
    })()
  }

  return {
    store,
    project,
    update,
    handOff,
    trackRecord,
    continueRound,
    expandOne,
    runToPrototype,
    runFromDevelop,
    stopLoop: () => {
      abort?.abort()
      abort = null
      update((draft) => {
        draft.loop.stage = 'stopped'
        for (const item of draft.loop.steps) {
          if (item.status === 'running') {
            item.status = 'failed'
            item.detail = '已手动停止'
          }
        }
        draft.loop.message = '已停止。会话里那一轮可能还在跑，去看一眼。'
      })
    },
    dismissLoop: () => {
      update((draft) => { draft.loop = { ...IDLE_LOOP, steps: [] } })
    },
    isSessionLive,
    dispose: () => {
      abort?.abort()
      for (const watch of watches.values()) watch.abort()
      watches.clear()
      offSessions()
      offWorkspaces()
    },
  }
}
