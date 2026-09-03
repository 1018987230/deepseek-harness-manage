// PopupPanel: the xgg-cycle workflow surface.
//
// A view over the root-scope store (controller.ts). It renders the phase menu
// and the phase panes, and drives dispatches; it owns no persisted state,
// because the automatic loop writes the same data and must outlive this
// component — its own dispatches navigate, which unmounts the copy of this
// panel that lives in the session header.
//
// Phases: 基础信息 → 需求 → 功能点 → 原型 → 开发 → 测试 → 上线.

import {
  createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode,
} from 'react'
import type { PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelController, ProjectState } from './controller.ts'
import {
  BUG_STATUSES, BUSY_STAGES, EMPTY_POINT_DRAFT, EMPTY_SERVER, HANDOFF_STATUSES, IDLE_LOOP,
  MAX_FIX_ROUNDS, PHASES, PROTOTYPE_MODES, RELEASE_TARGETS,
  buildDevelopContext, buildFixContext, buildPrototypeContext, buildReleaseContext,
  buildTestContext, isActionableBug, nextId, projectSession, protocolRecordLine as recordTitle,
  type BugItem, type BugStatus, type FeaturePoint, type HandOffRecord, type HandOffStatus,
  type LoopStage, type LoopState, type ModuleGroup, type NewPointDraft,
  type Requirement, type ServerConfig,
} from './project-model.ts'
import css from './PopupPanel.module.css'

/**
 * Registrant-private injected share (arrives via the register inject factory).
 * One handle: the root-scope controller that owns every persisted value and
 * the automatic loop.
 */
export interface PopupPanelInjected {
  controller: PanelController
}

const XggLocaleContext = createContext<TranslateNS<'xggCycle'> | null>(null)

/** Resolve the panel's locale seat for nested workflow components. */
function useXggTranslate(): TranslateNS<'xggCycle'> {
  const t = useContext(XggLocaleContext)
  if (t === null) throw new Error('xgg-cycle locale context is unavailable')
  return t
}

/** Fallback while the active project's entry has not been created yet. */
const EMPTY_PROJECT: ProjectState = {
  requirements: [], groups: [], info: [], records: [], bugs: [],
  mode: 'simple', releaseTarget: 'cloudflare', server: { ...EMPTY_SERVER },
  extras: { prototype: '', develop: '', test: '', release: '' },
  planSessionId: '',
  loop: { ...IDLE_LOOP, steps: [] },
}

/**
 * Component props. Only the inject face: the panel reads no owner props, which
 * is what lets one component occupy both the session header and the root-scope
 * sidebar foot.
 */
export type PopupPanelProps = PopupPanelInjected & PropsLocale<'xggCycle'>

/** The grouped module/points editor shared by the pick-modal and 功能点 phase. */
interface GroupedEditorProps {
  modules: ModuleGroup[]
  checked: ReadonlySet<string>
  checkable: boolean
  onToggle: (name: string) => void
  onAddModule: (name: string) => void
  onAddPoint: (moduleId: string, point: FeaturePoint) => void
  onRemovePoint: (name: string) => void
  onRemoveModule: (moduleId: string) => void
}

function GroupedEditor(props: GroupedEditorProps) {
  const t = useXggTranslate()
  const [newModuleName, setNewModuleName] = useState('')
  const [addingModule, setAddingModule] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, NewPointDraft>>({})

  const commitModule = () => {
    const name = newModuleName.trim()
    if (name === '') return
    props.onAddModule(name)
    setNewModuleName('')
    setAddingModule(false)
  }

  const commitPoint = (moduleId: string) => {
    const draft = drafts[moduleId]
    if (draft === undefined || draft.name.trim() === '') return
    props.onAddPoint(moduleId, {
      name: draft.name.trim(),
      priority: draft.priority,
      description: draft.description.trim(),
    })
    setDrafts(current => Object.fromEntries(
      Object.entries(current).filter(([key]) => key !== moduleId),
    ))
  }

  const updateDraft = (moduleId: string, patch: Partial<NewPointDraft>) => {
    setDrafts(current => ({ ...current, [moduleId]: { ...(current[moduleId] ?? EMPTY_POINT_DRAFT), ...patch } }))
  }

  return (
    <div className={css.moduleList}>
      {props.modules.map(mod => (
        <section key={mod.id} className={css.moduleCard}>
          <header className={css.moduleHeader}>
            <span className={css.moduleName}>{mod.name}</span>
            {!props.checkable && (
              <button type="button" className={css.removeButton} aria-label={t('copy.001', { p0: mod.name })} onClick={() => { props.onRemoveModule(mod.id) }}>✕</button>
            )}
          </header>
          <ul className={css.pointList}>
            {mod.points.map(point => (
              <li key={point.name} className={css.pointRow}>
                {/* Two lines on purpose: the delete control belongs beside the
                    title it deletes, and a wrapping description used to push it
                    onto a third line, far from anything it referred to. */}
                <div className={css.pointHead}>
                  {props.checkable && (
                    <input
                      type="checkbox"
                      className={css.pointCheck}
                      checked={props.checked.has(point.name)}
                      onChange={() => { props.onToggle(point.name) }}
                    />
                  )}
                  <span className={css[`priority${point.priority}`]}>{point.priority}</span>
                  {/* Truncated with the full text on hover: names run long, and
                      letting one wrap would break the row alignment again. */}
                  <span className={css.pointName} title={point.name}>{point.name}</span>
                  {point.done === true && (
                    <span
                      className={css.pointDone}
                      title={[
                        point.doneAt === undefined ? '' : `完成于 ${new Date(point.doneAt).toLocaleString()}`,
                        point.doneVersion === undefined ? '' : `原型 v${point.doneVersion}`,
                      ].filter(part => part !== '').join(' · ')}
                    >
                      {point.doneVersion === undefined ? t('copy.002') : t('copy.003', { p0: point.doneVersion })}
                    </span>
                  )}
                  {!props.checkable && (
                    <button type="button" className={css.removeButton} aria-label={t('copy.004', { p0: point.name })} onClick={() => { props.onRemovePoint(point.name) }}>✕</button>
                  )}
                </div>
                {point.description !== '' && <div className={css.pointDesc}>{point.description}</div>}
              </li>
            ))}
          </ul>
          {drafts[mod.id] === undefined
            ? (
              <button type="button" className={css.addPointLink} onClick={() => { updateDraft(mod.id, {}) }}>{t('copy.005')}</button>
            )
            : (
              <div className={css.addPointForm}>
                <input type="text" className={css.input} placeholder={t('copy.006')} value={drafts[mod.id]?.name ?? ''} onChange={(event) => { updateDraft(mod.id, { name: event.target.value }) }} />
                <select className={css.prioritySelect} value={drafts[mod.id]?.priority ?? 'P2'} onChange={(event) => { updateDraft(mod.id, { priority: event.target.value as FeaturePoint['priority'] }) }}>
                  <option value="P0">{t('copy.007')}</option>
                  <option value="P1">{t('copy.008')}</option>
                  <option value="P2">{t('copy.009')}</option>
                </select>
                <input type="text" className={css.input} placeholder={t('copy.010')} value={drafts[mod.id]?.description ?? ''} onChange={(event) => { updateDraft(mod.id, { description: event.target.value }) }} />
                <button type="button" className={css.addButton} onClick={() => { commitPoint(mod.id) }}>{t('copy.011')}</button>
              </div>
            )}
        </section>
      ))}

      {addingModule
        ? (
          <div className={css.addModuleForm}>
            <input type="text" className={css.input} placeholder={t('copy.012')} value={newModuleName} onChange={(event) => { setNewModuleName(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') commitModule() }} />
            <button type="button" className={css.addButton} onClick={commitModule}>{t('copy.011')}</button>
            <button type="button" className={css.cancelButton} onClick={() => { setAddingModule(false); setNewModuleName('') }}>{t('copy.013')}</button>
          </div>
        )
        : (
          <button type="button" className={css.addModuleLink} onClick={() => { setAddingModule(true) }}>{t('copy.014')}</button>
        )}
    </div>
  )
}

/** Props of the dispatched-record list. */
interface RecordListProps {
  records: readonly HandOffRecord[]
  emptyText: string
  onStatusChange: (id: string, status: HandOffStatus) => void
  onRemove: (id: string) => void
  /** Nudge a still-running round to finish (it reported a turn but not completion). */
  onContinue: (id: string) => void
}

/**
 * The dispatched hand-offs of one phase: a collapsed row each, expanding to the
 * message exactly as it was sent. Status is a live picker — set to 进行中 on
 * dispatch, revised freely afterwards in either direction.
 * @param props - the records and their mutation callbacks.
 * @returns The list.
 */
function RecordList(props: RecordListProps) {
  const t = useXggTranslate()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  if (props.records.length === 0) return <div className={css.empty}>{props.emptyText}</div>

  return (
    <ul className={css.recordList}>
      {props.records.map(record => (
        <li key={record.id} className={css.recordItem}>
          <div className={css.recordHead}>
            <button
              type="button"
              className={css.recordToggle}
              aria-expanded={expandedId === record.id}
              onClick={() => { setExpandedId(current => current === record.id ? null : record.id) }}
            >
              <span className={css.recordCaret} aria-hidden="true">{expandedId === record.id ? '▾' : '▸'}</span>
              <span className={css.recordTitle}>{recordTitle(record)}</span>
              {record.mode !== undefined && (
                <span className={css.recordMeta}>{record.mode === 'full' ? t('copy.015') : t('copy.016')}</span>
              )}
              {record.target !== undefined && (
                <span className={css.recordMeta}>{record.target === 'server' ? t('copy.017') : t('copy.018')}</span>
              )}
              <span className={css.recordMeta}>{new Date(record.createdAt).toLocaleString()}</span>
              {record.note !== undefined && <span className={css.recordNote}>{record.note}</span>}
            </button>
            {record.status === 'active' && (
              <button
                type="button"
                className={css.continueButton}
                title={t('copy.019')}
                onClick={() => { props.onContinue(record.id) }}
              >
                {t('copy.020')}</button>
            )}
            <select
              className={css.statusSelect}
              aria-label={t('copy.021', { p0: recordTitle(record) })}
              value={record.status}
              onChange={(event) => { props.onStatusChange(record.id, event.target.value as HandOffStatus) }}
            >
              {HANDOFF_STATUSES.map(item => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
            <button type="button" className={css.removeButton} aria-label={t('copy.022', { p0: recordTitle(record) })} onClick={() => { props.onRemove(record.id) }}>✕</button>
          </div>
          {expandedId === record.id && <pre className={css.recordBody}>{record.content}</pre>}
        </li>
      ))}
    </ul>
  )
}

/** Props of the manual bug board. */
interface BugBoardProps {
  bugs: readonly BugItem[]
  onAdd: (bug: { title: string; detail: string; severity: FeaturePoint['priority'] }) => void
  onStatusChange: (id: string, status: BugStatus) => void
  onRemove: (id: string) => void
  /** Ids ticked for the next 修复 round. */
  checked: ReadonlySet<string>
  onToggle: (id: string) => void
  /** The message the tick selection would send, for the collapsible preview. */
  fixContext: string
  onStartFix: () => void
  fixBusy: boolean
  fixError: string | null
}

/**
 * Problems the user files by hand, alongside whatever the automatic round
 * reports. Anything still 待修复 or 修复中 rides the next 测试 hand-off; a
 * 已修复 / 不修复 entry stays for the record but stops being re-sent.
 *
 * Ticking rows selects a subset for a 修复 round: fixing everything at once is
 * rarely what is wanted, so the round carries only what is ticked.
 * @param props - the bugs and their mutation callbacks.
 * @returns The board.
 */
function BugBoard(props: BugBoardProps) {
  const t = useXggTranslate()
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [severity, setSeverity] = useState<FeaturePoint['priority']>('P1')
  const [previewOpen, setPreviewOpen] = useState(false)
  // A tick on a settled problem never counts, even if the selection still
  // carries it — a status can change (by hand, or by a fix round's report)
  // long after the box was ticked.
  const selectable = props.bugs.filter(bug => isActionableBug(bug) && props.checked.has(bug.id)).length

  const commit = () => {
    if (title.trim() === '') return
    props.onAdd({ title: title.trim(), detail: detail.trim(), severity })
    setTitle('')
    setDetail('')
  }

  return (
    <div className={css.recordSection}>
      <div className={css.previewTitle}>{t('copy.023')}</div>
      <div className={css.addRow}>
        <input type="text" className={css.input} placeholder={t('copy.024')} value={title} onChange={(event) => { setTitle(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
        <input type="text" className={css.input} placeholder={t('copy.025')} value={detail} onChange={(event) => { setDetail(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
        <select className={css.prioritySelect} aria-label={t('copy.026')} value={severity} onChange={(event) => { setSeverity(event.target.value as FeaturePoint['priority']) }}>
          <option value="P0">{t('copy.027')}</option>
          <option value="P1">{t('copy.028')}</option>
          <option value="P2">{t('copy.029')}</option>
        </select>
        <button type="button" className={css.addButton} onClick={commit}>{t('copy.030')}</button>
      </div>
      {props.bugs.length === 0
        ? <div className={css.empty}>{t('copy.031')}</div>
        : (
          <>
            <div className={css.modeBar}>
              <div className={css.targetNotice}>
                {selectable === 0
                  ? t('copy.032')
                  : t('copy.033', { p0: selectable })}
              </div>
              <button type="button" className={css.confirmButton} disabled={props.fixBusy || selectable === 0} onClick={props.onStartFix}>
                {props.fixBusy ? t('copy.034') : t('copy.035', { p0: selectable })}
              </button>
            </div>
            {props.fixError !== null && <div className={css.startError} role="alert">{props.fixError}</div>}
            <ul className={css.recordList}>
              {props.bugs.map(bug => (
                <li key={bug.id} className={isActionableBug(bug) ? css.recordItem : css.recordItemSettled}>
                  <div className={css.recordHead}>
                    <input
                      type="checkbox"
                      className={css.pointCheck}
                      aria-label={t('copy.036', { p0: bug.title })}
                      checked={isActionableBug(bug) && props.checked.has(bug.id)}
                      disabled={!isActionableBug(bug)}
                      title={isActionableBug(bug)
                        ? undefined
                        : t('copy.037')}
                      onChange={() => { props.onToggle(bug.id) }}
                    />
                    <span className={css[`priority${bug.severity}`]}>{bug.severity}</span>
                    <span className={css.bugTitle}>{bug.title}</span>
                    <select
                      className={css.statusSelect}
                      aria-label={t('copy.021', { p0: bug.title })}
                      value={bug.status}
                      onChange={(event) => { props.onStatusChange(bug.id, event.target.value as BugStatus) }}
                    >
                      {BUG_STATUSES.map(item => (
                        <option key={item.id} value={item.id}>{item.label}</option>
                      ))}
                    </select>
                    <button type="button" className={css.removeButton} aria-label={t('copy.022', { p0: bug.title })} onClick={() => { props.onRemove(bug.id) }}>✕</button>
                  </div>
                  {bug.detail !== '' && <div className={css.bugDetail}>{bug.detail}</div>}
                  {bug.note !== undefined && <div className={css.bugNote}>{bug.note}</div>}
                </li>
              ))}
            </ul>
            {selectable > 0 && (
              <div className={css.preview}>
                <div className={css.previewHead}>
                  <button
                    type="button"
                    className={css.recordToggle}
                    aria-expanded={previewOpen}
                    onClick={() => { setPreviewOpen(current => !current) }}
                  >
                    <span className={css.recordCaret} aria-hidden="true">{previewOpen ? '▾' : '▸'}</span>
                    <span className={css.previewTitle}>{t('copy.038')}</span>
                  </button>
                </div>
                {previewOpen && <pre className={css.previewBody}>{props.fixContext}</pre>}
              </div>
            )}
          </>
        )}
    </div>
  )
}

/** Props of the automatic-loop banner. */
interface LoopBannerProps {
  loop: LoopState
  onStart: () => void
  /** Resume from 正式开发 when a run died after its prototype landed. */
  onResumeDevelop: () => void
  onStop: () => void
  onDismiss: () => void
}

/** Locale key per stage, used for the banner's headline. */
const STAGE_LABEL_KEYS = {
  'idle': 'copy.039',
  'expanding': 'copy.040',
  'prototyping': 'copy.041',
  'developing': 'copy.042',
  'testing': 'copy.043',
  'fixing': 'copy.044',
  'done': 'copy.045',
  'failed': 'copy.046',
  'stopped': 'copy.047',
} as const satisfies Readonly<Record<LoopStage, `copy.${string}`>>

/**
 * The automatic run's control band and progress log, pinned above the phase
 * content so it stays visible from every phase while a run is in flight.
 *
 * The run never pauses: it goes 功能点 → 原型 → 正式开发 → 测试/修复 without a
 * gate, and every round is told not to ask questions, because a round waiting
 * on an answer stalls the whole loop.
 * @param props - loop state and its控制 callbacks.
 * @returns The banner.
 */
function LoopBanner(props: LoopBannerProps) {
  const t = useXggTranslate()
  const { loop } = props
  const busy = BUSY_STAGES.includes(loop.stage)
  const idle = loop.stage === 'idle' && loop.steps.length === 0

  return (
    <div className={busy ? css.loopBannerBusy : css.loopBanner}>
      <div className={css.loopHead}>
        <span className={css.loopTitle}>{t(STAGE_LABEL_KEYS[loop.stage])}</span>
        {loop.round > 0 && <span className={css.recordMeta}>{t('copy.048')}{loop.round} / {MAX_FIX_ROUNDS} {t('copy.049')}</span>}
        <span className={css.loopSpacer} />
        {busy
          ? <button type="button" className={css.cancelButton} onClick={props.onStop}>{t('copy.050')}</button>
          : (
            <>
              {(loop.stage === 'failed' || loop.stage === 'stopped') && loop.sessionId !== '' && (
                <button type="button" className={css.cancelButton} onClick={props.onResumeDevelop}>
                  {t('copy.051')}</button>
              )}
              <button type="button" className={idle ? css.confirmButton : css.cancelButton} onClick={props.onStart}>
                {idle ? t('copy.052') : t('copy.053')}
              </button>
              {!idle && (
                <button type="button" className={css.removeButton} aria-label={t('copy.054')} onClick={props.onDismiss}>✕</button>
              )}
            </>
          )}
      </div>
      <div className={css.loopMessage}>
        {loop.message === ''
          ? t('copy.055')
          : loop.message}
      </div>
      {loop.steps.length > 0 && (
        <ul className={css.loopSteps}>
          {loop.steps.map(step => (
            <li key={step.id} className={css.loopStep}>
              <span className={css.loopStepMark} aria-hidden="true">
                {step.status === 'running' ? '◌' : step.status === 'ok' ? '✓' : '✕'}
              </span>
              <span className={css.loopStepLabel}>{step.label}</span>
              {step.detail !== '' && <span className={css.recordMeta}>{step.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Props of the SSH connection form. */
interface ServerFormProps {
  server: ServerConfig
  onChange: (patch: Partial<ServerConfig>) => void
  password: string
  onPasswordChange: (value: string) => void
}

/**
 * SSH connection fields for the 服务器直连 target. Everything here except the
 * password is remembered; the password is held only for as long as the panel
 * is mounted, because the message it rides into is written to the session log.
 * @param props - the fields and their write paths.
 * @returns The form.
 */
function ServerForm(props: ServerFormProps) {
  const t = useXggTranslate()
  return (
    <div className={css.recordSection}>
      <div className={css.previewTitle}>{t('copy.056')}</div>
      <div className={css.addRow}>
        <input type="text" className={css.input} placeholder={t('copy.057')} value={props.server.host} onChange={(event) => { props.onChange({ host: event.target.value }) }} />
        <input type="text" className={css.serverPort} placeholder={t('copy.058')} value={props.server.port} onChange={(event) => { props.onChange({ port: event.target.value }) }} />
        <input type="text" className={css.input} placeholder={t('copy.059')} value={props.server.user} onChange={(event) => { props.onChange({ user: event.target.value }) }} />
      </div>
      <div className={css.addRow}>
        <input type="password" className={css.input} placeholder={t('copy.060')} value={props.password} onChange={(event) => { props.onPasswordChange(event.target.value) }} />
        <input type="text" className={css.input} placeholder={t('copy.061')} value={props.server.path} onChange={(event) => { props.onChange({ path: event.target.value }) }} />
      </div>
      <div className={css.secretNotice}>
        {t('copy.062')}</div>
    </div>
  )
}

/**
 * A destructive action held back for a second look.
 *
 * Every delete in this panel is irreversible — the store is the only copy, and
 * a removed requirement takes its feature points, its prototype lineage and
 * its bugs' context with it. So they all route through one dialog rather than
 * each growing its own guard.
 */
interface PendingConfirm {
  /** What is about to be deleted, as a verb phrase. */
  title: string
  /** The specific item, echoed so the user can check they hit the right ✕. */
  detail: string
  run: () => void
}

/** Props of the shared hand-off pane (原型 and 开发 differ only in their copy). */
interface HandOffPaneProps {
  /** Sentence under the phase title. */
  description: string
  /** Phase-specific controls sitting left of the action button (原型's shape picker). */
  controls?: ReactNode
  /** Action button copy while idle. */
  actionLabel: string
  /** Action button copy while the hand-off is in flight. */
  busyLabel: string
  busy: boolean
  /** Failure text from the last attempt, or null. */
  error: string | null
  /** The append box's text and its write path. */
  extra: string
  onExtraChange: (text: string) => void
  /** Discards the whole append box — routed through the confirm dialog. */
  onClearExtra: () => void
  extraPlaceholder: string
  /** The fully assembled message — exactly what the action sends. */
  context: string
  onStart: () => void
  /** Phase-specific block rendered between the compose box and the record list. */
  sections?: ReactNode
  /** Everything this phase has already dispatched, newest first. */
  records: readonly HandOffRecord[]
  recordsEmptyText: string
  onStatusChange: (id: string, status: HandOffStatus) => void
  onRemove: (id: string) => void
  onContinue: (id: string) => void
}

/**
 * The hand-off surface shared by 原型 and 开发: a control band, the compose box
 * (append text plus a collapsible preview of the assembled message), and the
 * list of what this phase has already dispatched. Both the pending preview and
 * each past record stay collapsed until clicked.
 * @param props - copy, state and callbacks of the owning phase.
 * @returns The pane.
 */
function HandOffPane(props: HandOffPaneProps) {
  const t = useXggTranslate()
  const [previewOpen, setPreviewOpen] = useState(false)

  return (
    <div className={css.featurePane}>
      <p className={css.phaseDescription}>{props.description}</p>
      <div className={css.modeBar}>
        {props.controls}
        <button type="button" className={css.confirmButton} disabled={props.busy} onClick={props.onStart}>
          {props.busy ? props.busyLabel : props.actionLabel}
        </button>
      </div>
      {props.error !== null && <div className={css.startError} role="alert">{props.error}</div>}
      <div className={css.preview}>
        <div className={css.previewHead}>
          <button
            type="button"
            className={css.recordToggle}
            aria-expanded={previewOpen}
            onClick={() => { setPreviewOpen(current => !current) }}
          >
            <span className={css.recordCaret} aria-hidden="true">{previewOpen ? '▾' : '▸'}</span>
            <span className={css.previewTitle}>{t('copy.063')}</span>
          </button>
          {props.extra.trim() !== '' && (
            <button type="button" className={css.clearExtraLink} onClick={props.onClearExtra}>{t('copy.064')}</button>
          )}
        </div>
        <textarea
          className={css.extraInput}
          rows={3}
          value={props.extra}
          placeholder={props.extraPlaceholder}
          onChange={(event) => { props.onExtraChange(event.target.value) }}
        />
        {previewOpen && <pre className={css.previewBody}>{props.context}</pre>}
      </div>
      {props.sections}
      <div className={css.recordSection}>
        <div className={css.previewTitle}>{t('copy.065')}</div>
        <RecordList
          records={props.records}
          emptyText={props.recordsEmptyText}
          onStatusChange={props.onStatusChange}
          onRemove={props.onRemove}
          onContinue={props.onContinue}
        />
      </div>
    </div>
  )
}

/**
 * Render the session-header toggle and, while open, the workflow panel.
 * @param props - the slot runtime share plus `startPrototypeSession`, which
 *   carries the assembled context into a newly created session.
 * @returns The toggle button plus the conditional panel.
 */
export function PopupPanel({ controller, t }: PopupPanelProps) {
  // Persisted project data lives in the root-scope store (see controller.ts):
  // the loop writes it too, and the loop must survive this component being
  // unmounted by the navigation its own dispatches cause.
  const panel = useSyncExternalStore(
    listener => controller.store.subscribe(listener),
    () => controller.store.getSnapshot(),
  )
  const project = panel.projects[panel.activeKey] ?? EMPTY_PROJECT
  const { requirements, groups, info, records, bugs, mode, releaseTarget, server, loop } = project
  const extra = project.extras.prototype
  const devExtra = project.extras.develop
  const testExtra = project.extras.test
  const releaseExtra = project.extras.release

  // Field-shaped adapters over the store's single update verb, so the call
  // sites below stay the plain `setX(next)` / `setX(prev => next)` they were.
  const field = useCallback(<K extends keyof ProjectState>(key: K) =>
    (next: ProjectState[K] | ((current: ProjectState[K]) => ProjectState[K])) => {
      const current = controller.project()[key]
      const value = typeof next === 'function'
        ? (next)(current)
        : next
      controller.update((draft) => { draft[key] = value })
    }, [controller])
  const extraField = useCallback((key: keyof ProjectState['extras']) =>
    (next: string) => { controller.update((draft) => { draft.extras[key] = next }) }, [controller])

  const setRequirements = useMemo(() => field('requirements'), [field])
  const setGroups = useMemo(() => field('groups'), [field])
  const setInfo = useMemo(() => field('info'), [field])
  const setRecords = useMemo(() => field('records'), [field])
  const setBugs = useMemo(() => field('bugs'), [field])
  const setMode = useMemo(() => field('mode'), [field])
  const setReleaseTarget = useMemo(() => field('releaseTarget'), [field])
  const setServer = useMemo(() => field('server'), [field])
  const setExtra = useMemo(() => extraField('prototype'), [extraField])
  const setDevExtra = useMemo(() => extraField('develop'), [extraField])
  const setTestExtra = useMemo(() => extraField('test'), [extraField])
  const setReleaseExtra = useMemo(() => extraField('release'), [extraField])

  // Purely local: view state, in-progress form text, and the one secret that
  // must never reach storage.
  const [open, setOpen] = useState(false)
  const [phaseId, setPhaseId] = useState<string>(PHASES[0]?.id ?? 'info')
  const [draft, setDraft] = useState('')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [devStarting, setDevStarting] = useState(false)
  const [devError, setDevError] = useState<string | null>(null)
  const [testStarting, setTestStarting] = useState(false)
  const [testError, setTestError] = useState<string | null>(null)
  const [checkedBugs, setCheckedBugs] = useState<ReadonlySet<string>>(new Set())
  const [fixStarting, setFixStarting] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [releaseStarting, setReleaseStarting] = useState(false)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  /**
   * Hold a destructive action until the user confirms it.
   * @param title - what is about to be deleted.
   * @param detail - which item, echoed back.
   * @param run - the deletion to perform on confirmation.
   */
  const askConfirm = useCallback((title: string, detail: string, run: () => void) => {
    setPending({ title, detail, run })
  }, [])
  // 基础信息 add form state.
  const [infoKey, setInfoKey] = useState('')
  const [infoValue, setInfoValue] = useState('')
  const [openTableId, setOpenTableId] = useState<string | null>(null)
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())

  const activePhase = PHASES.find(phase => phase.id === phaseId) ?? PHASES[0]

  // ── 基础信息 ────────────────────────────────────────────────────────────
  const addInfo = useCallback(() => {
    const key = infoKey.trim()
    const value = infoValue.trim()
    if (key === '' || value === '') return
    setInfo(current => [...current, { id: nextId('info'), key, value }])
    setInfoKey('')
    setInfoValue('')
  }, [infoKey, infoValue])

  const removeInfo = useCallback((id: string) => {
    setInfo(current => current.filter(entry => entry.id !== id))
  }, [])

  // ── 需求 ────────────────────────────────────────────────────────────────
  const addRequirement = useCallback(() => {
    const text = draft.trim()
    if (text === '') return
    setRequirements(current => [...current, { id: nextId('req'), text, expanded: false, modules: [] }])
    setDraft('')
  }, [draft])

  const removeRequirement = useCallback((id: string) => {
    setRequirements(current => current.filter(item => item.id !== id))
    if (openTableId === id) setOpenTableId(null)
  }, [openTableId])

  const expandRequirement = useCallback((id: string) => {
    // Progress and failure live on the requirement itself: this dispatch
    // navigates, which unmounts this component, so anything held here would be
    // lost mid-request.
    void controller.expandOne(id)
  }, [controller])

  // Reopening must show the saved selection, not a fresh all-ticked sheet: the
  // confirmed group IS the selection, so it seeds the ticks. Only a requirement
  // that has never been confirmed starts all-ticked (the first-open default).
  const openRequirement = useCallback((req: Requirement) => {
    setOpenTableId(req.id)
    const confirmed = groups.find(group => group.reqId === req.id)
    const names = new Set<string>()
    if (confirmed === undefined) {
      for (const mod of req.modules) for (const point of mod.points) names.add(point.name)
    } else {
      for (const mod of confirmed.modules) for (const point of mod.points) names.add(point.name)
    }
    setChecked(names)
  }, [groups])

  const openReqAddModule = useCallback((name: string) => {
    setRequirements(current => current.map(item => item.id === openTableId
      ? { ...item, modules: [...item.modules, { id: nextId('mod'), name, points: [] }] }
      : item))
  }, [openTableId])

  const openReqAddPoint = useCallback((moduleId: string, point: FeaturePoint) => {
    setRequirements(current => current.map(item => item.id === openTableId
      ? { ...item, modules: item.modules.map(mod => mod.id === moduleId ? { ...mod, points: [...mod.points, point] } : mod) }
      : item))
    setChecked(current => new Set(current).add(point.name))
  }, [openTableId])

  // Project the tick set onto this requirement's feature-point group: ticked
  // points are kept, unticked ones are dropped. NOT an accumulator — 确认 is how
  // the user removes a point, so a previously confirmed point that is no longer
  // ticked has to go.
  //
  // Sources are unioned before filtering because the two can diverge: a point
  // may exist only among the candidates (newly expanded, or added by hand in
  // this modal) or only in the confirmed group (a later re-expansion dropped it
  // upstream). Either way its tick decides its fate.
  const confirmRequirement = useCallback(() => {
    if (openTableId === null) return
    const req = requirements.find(item => item.id === openTableId)
    if (req === undefined) return
    setGroups((current) => {
      const base = current.find(group => group.reqId === req.id)
      const merged: ModuleGroup[] = []
      const seen = new Set<string>()
      for (const mod of [...(base?.modules ?? []), ...req.modules]) {
        const kept = mod.points.filter(point => checked.has(point.name) && !seen.has(point.name))
        for (const point of kept) seen.add(point.name)
        if (kept.length === 0) continue
        const target = merged.find(entry => entry.name === mod.name)
        if (target !== undefined) target.points.push(...kept)
        else merged.push({ id: nextId('mod'), name: mod.name, points: kept })
      }
      // Nothing ticked means this requirement contributes no feature points.
      if (merged.length === 0) return current.filter(group => group.reqId !== req.id)
      if (base === undefined) {
        return [...current, { reqId: req.id, reqText: req.text, modules: merged }]
      }
      return current.map(group => group.reqId === req.id ? { ...group, modules: merged } : group)
    })
    setOpenTableId(null)
    setChecked(new Set())
  }, [openTableId, checked, requirements])

  // ── 功能点（按需求分组，组内按模块） ────────────────────────────────────
  const addGroupModule = useCallback((reqId: string, name: string) => {
    setGroups((current) => {
      const group = current.find(g => g.reqId === reqId)
      if (group === undefined) return current
      return current.map(g => g.reqId === reqId
        ? { ...g, modules: [...g.modules, { id: nextId('mod'), name, points: [] }] }
        : g)
    })
  }, [])

  const addGroupPoint = useCallback((reqId: string, moduleId: string, point: FeaturePoint) => {
    setGroups(current => current.map(g => g.reqId === reqId
      ? { ...g, modules: g.modules.map(mod => mod.id === moduleId ? { ...mod, points: [...mod.points, point] } : mod) }
      : g))
  }, [])

  const removeGroupPoint = useCallback((reqId: string, name: string) => {
    setGroups(current => current.map((g) => {
      if (g.reqId !== reqId) return g
      const modules = g.modules.map(mod => ({ ...mod, points: mod.points.filter(p => p.name !== name) }))
        .filter(mod => mod.points.length > 0)
      return { ...g, modules }
    }).filter(g => g.modules.length > 0))
  }, [])

  const removeGroupModule = useCallback((reqId: string, moduleId: string) => {
    setGroups(current => current.map(g => g.reqId === reqId
      ? { ...g, modules: g.modules.filter(mod => mod.id !== moduleId) }
      : g).filter(g => g.modules.length > 0))
  }, [])

  const removeGroup = useCallback((reqId: string) => {
    setGroups(current => current.filter(g => g.reqId !== reqId))
  }, [])

  // ── 原型：assembled context → a brand-new session ──────────────────
  // Value-stable across renders while the inputs are unchanged (a plain
  // string), so it doubles as the preview body and as a useCallback dependency.
  // ── 原型 / 开发：dispatch, versioning and record keeping ────────────────
  const prototypeRecords = records.filter(record => record.kind === 'prototype')
  const developRecords = records.filter(record => record.kind === 'develop' || record.kind === 'fix')
  const testRecords = records.filter(record => record.kind === 'test')

  const addRecord = useCallback((record: HandOffRecord) => {
    setRecords(current => [record, ...current])
  }, [])

  const setRecordStatus = useCallback((id: string, status: HandOffStatus) => {
    setRecords(current => current.map(record => record.id === id ? { ...record, status } : record))
  }, [])

  const removeRecord = useCallback((id: string) => {
    setRecords(current => current.filter(record => record.id !== id))
  }, [])

  // Versions never reuse a number, so a deleted or dropped v2 does not hand its
  // number to the next generation and collide in the transcripts.
  const nextPrototypeVersion = prototypeRecords.reduce((max, record) => Math.max(max, record.version), 0) + 1
  // v2+ iterates inside the session earlier versions were built in: a fresh
  // session knows nothing of v1 and the output drifts. Only a project with no
  // usable session left opens one, and then the message carries the ledger.
  const liveSessionId = projectSession(records, sessionId => controller.isSessionLive(sessionId))
  const prototypeContext = buildPrototypeContext(
    info, requirements, groups, mode, extra, nextPrototypeVersion, liveSessionId !== undefined, records,
  )
  const startPrototype = useCallback(() => {
    setStartError(null)
    setStarting(true)
    void controller.handOff(prototypeContext, liveSessionId).then(
      (sessionId) => {
        setStarting(false)
        const recordId = nextId('ph')
        addRecord({
          id: recordId, kind: 'prototype', version: nextPrototypeVersion, mode,
          createdAt: Date.now(), sessionId, status: 'active', content: prototypeContext,
        })
        controller.trackRecord(recordId, sessionId)
        // That session is now current; this panel belongs to the old one.
        setOpen(false)
      },
      (reason: unknown) => {
        setStarting(false)
        setStartError(`新开会话失败：${reason instanceof Error ? reason.message : String(reason)}`)
      },
    )
  }, [controller, prototypeContext, liveSessionId, addRecord, nextPrototypeVersion, mode])

  // ── 开发：continue in the session the matched 原型 opened ────────────────
  // The match is the newest prototype the user has not dropped. Its session can
  // still be archived or deleted between phases; when it no longer resolves the
  // hand-off opens a fresh one, and the message then carries the shared
  // sections that session would otherwise be missing.
  const basePrototype = prototypeRecords.find(record => record.status !== 'dropped')
  const devTargetLive = liveSessionId !== undefined
  const baseVersion = basePrototype !== undefined && controller.isSessionLive(basePrototype.sessionId)
    ? basePrototype.version
    : undefined
  const devRound = records
    .filter(record => record.kind === 'develop' && record.baseVersion === baseVersion).length + 1
  const developContext = buildDevelopContext(
    info, requirements, groups, devExtra, !devTargetLive, baseVersion, devRound, records,
  )
  const startDevelop = useCallback(() => {
    setDevError(null)
    setDevStarting(true)
    void controller.handOff(developContext, liveSessionId).then(
      (sessionId) => {
        setDevStarting(false)
        const recordId = nextId('dh')
        addRecord({
          id: recordId, kind: 'develop', version: devRound,
          ...(baseVersion === undefined ? {} : { baseVersion }),
          createdAt: Date.now(), sessionId, status: 'active', content: developContext,
        })
        controller.trackRecord(recordId, sessionId)
        setOpen(false)
      },
      (reason: unknown) => {
        setDevStarting(false)
        setDevError(`开始开发失败：${reason instanceof Error ? reason.message : String(reason)}`)
      },
    )
  }, [controller, developContext, liveSessionId, addRecord, devRound, baseVersion])

  // ── 测试：the same target as 开发, plus the user's own open problems ──────
  const addBug = useCallback((bug: { title: string; detail: string; severity: FeaturePoint['priority'] }) => {
    setBugs(current => [{ ...bug, id: nextId('bug'), status: 'open', createdAt: Date.now() }, ...current])
  }, [])

  const setBugStatus = useCallback((id: string, status: BugStatus) => {
    setBugs(current => current.map(bug => bug.id === id ? { ...bug, status } : bug))
  }, [])

  // ── Confirm-guarded deletes ─────────────────────────────────────────────
  // Wrapped here rather than inside GroupedEditor / RecordList / BugBoard: the
  // guard belongs to whoever owns the data, and keeping it at the hand-down
  // point leaves those components unaware a dialog exists.
  const askRemoveInfo = useCallback((id: string) => {
    const entry = info.find(item => item.id === id)
    askConfirm('删除基础信息字段', entry === undefined ? id : `${entry.key}: ${entry.value}`, () => { removeInfo(id) })
  }, [askConfirm, info, removeInfo])

  const askRemoveRequirement = useCallback((id: string) => {
    const item = requirements.find(entry => entry.id === id)
    askConfirm(
      '删除需求',
      `${item?.text ?? id}\n它已确认的功能点会一并删除。`,
      () => { removeRequirement(id) },
    )
  }, [askConfirm, requirements, removeRequirement])

  const askRemoveGroup = useCallback((reqId: string) => {
    const group = groups.find(item => item.reqId === reqId)
    askConfirm('删除该需求的全部功能点', group?.reqText ?? reqId, () => { removeGroup(reqId) })
  }, [askConfirm, groups, removeGroup])

  const askRemoveGroupPoint = useCallback((reqId: string, name: string) => {
    askConfirm('删除功能点', name, () => { removeGroupPoint(reqId, name) })
  }, [askConfirm, removeGroupPoint])

  const askRemoveGroupModule = useCallback((reqId: string, moduleId: string) => {
    const target = groups.find(item => item.reqId === reqId)?.modules.find(mod => mod.id === moduleId)
    askConfirm(
      '删除模块',
      `${target?.name ?? moduleId}（含 ${target?.points.length ?? 0} 个功能点）`,
      () => { removeGroupModule(reqId, moduleId) },
    )
  }, [askConfirm, groups, removeGroupModule])

  const continueRound = useCallback((id: string) => {
    void controller.continueRound(id)
  }, [controller])

  const askRemoveRecord = useCallback((id: string) => {
    const record = records.find(item => item.id === id)
    askConfirm('删除记录', record === undefined ? id : recordTitle(record), () => { removeRecord(id) })
  }, [askConfirm, records, removeRecord])

  const askClearExtra = useCallback((label: string, clear: () => void) => {
    askConfirm('清空追加内容', `${label}阶段这次追加的文字会被丢弃。`, clear)
  }, [askConfirm])

  const askDismissLoop = useCallback(() => {
    askConfirm('清空流程记录', '这次自动流程的进度日志会被清空（已产生的原型、开发、测试记录不受影响）。', () => { controller.dismissLoop() })
  }, [askConfirm, controller])

  const removeBug = useCallback((id: string) => {
    setBugs(current => current.filter(bug => bug.id !== id))
    setCheckedBugs((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }, [])

  const askRemoveBug = useCallback((id: string) => {
    const bug = bugs.find(item => item.id === id)
    askConfirm('删除问题', bug === undefined ? id : `[${bug.severity}] ${bug.title}`, () => { removeBug(id) })
  }, [askConfirm, bugs, removeBug])

  const toggleBug = useCallback((id: string) => {
    setCheckedBugs((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Settled problems stay on the board for the record but stop riding along.
  const openBugs = bugs.filter(isActionableBug)
  const testRound = testRecords.filter(record => record.baseVersion === baseVersion).length + 1
  const testContext = buildTestContext(
    info, requirements, groups, testExtra, !devTargetLive, baseVersion, testRound, openBugs, records,
  )
  const startTest = useCallback(() => {
    setTestError(null)
    setTestStarting(true)
    void controller.handOff(testContext, liveSessionId).then(
      (sessionId) => {
        setTestStarting(false)
        const recordId = nextId('th')
        addRecord({
          id: recordId, kind: 'test', version: testRound,
          ...(baseVersion === undefined ? {} : { baseVersion }),
          createdAt: Date.now(), sessionId, status: 'active', content: testContext,
        })
        controller.trackRecord(recordId, sessionId)
        setOpen(false)
      },
      (reason: unknown) => {
        setTestStarting(false)
        setTestError(`开始测试失败：${reason instanceof Error ? reason.message : String(reason)}`)
      },
    )
  }, [controller, testContext, liveSessionId, addRecord, testRound, baseVersion])

  // ── 修复：the ticked subset, dispatched to the development session ───────
  const fixRecords = records.filter(record => record.kind === 'fix')
  const selectedBugs = bugs.filter(bug => checkedBugs.has(bug.id) && isActionableBug(bug))
  const fixRound = fixRecords.filter(record => record.baseVersion === baseVersion).length + 1
  const fixContext = buildFixContext(selectedBugs, fixRound, baseVersion)
  const startFix = useCallback(() => {
    if (selectedBugs.length === 0) return
    setFixError(null)
    setFixStarting(true)
    void controller.handOff(fixContext, liveSessionId).then(
      (sessionId) => {
        setFixStarting(false)
        // Dispatched problems move to 修复中 in place — the board is the
        // feedback surface, while the round itself is logged under 开发.
        const dispatched = new Set(selectedBugs.map(bug => bug.id))
        setBugs(current => current.map(bug => dispatched.has(bug.id) ? { ...bug, status: 'fixing' } : bug))
        setCheckedBugs(new Set())
        const recordId = nextId('fh')
        addRecord({
          id: recordId, kind: 'fix', version: fixRound,
          ...(baseVersion === undefined ? {} : { baseVersion }),
          createdAt: Date.now(), sessionId, status: 'active', content: fixContext,
        })
        controller.trackRecord(recordId, sessionId)
        setOpen(false)
      },
      (reason: unknown) => {
        setFixStarting(false)
        setFixError(`开始修复失败：${reason instanceof Error ? reason.message : String(reason)}`)
      },
    )
  }, [controller, fixContext, selectedBugs, liveSessionId, addRecord, fixRound, baseVersion])

  // ── 上线：same session, one of two deploy targets ───────────────────────
  const releaseRecords = records.filter(record => record.kind === 'release')
  const releaseRound = releaseRecords.filter(record => record.baseVersion === baseVersion).length + 1
  const patchServer = useCallback((patch: Partial<ServerConfig>) => {
    setServer(current => ({ ...current, ...patch }))
  }, [])
  // Two renderings of one message: the preview shows what actually goes out;
  // the archived copy masks the credential (see HandOffRecord.content).
  const releaseContext = buildReleaseContext(
    releaseExtra, releaseTarget, server, password, releaseRound, baseVersion, false,
  )
  const releaseArchive = buildReleaseContext(
    releaseExtra, releaseTarget, server, password, releaseRound, baseVersion, true,
  )
  const startRelease = useCallback(() => {
    setReleaseError(null)
    setReleaseStarting(true)
    void controller.handOff(releaseContext, liveSessionId).then(
      (sessionId) => {
        setReleaseStarting(false)
        const recordId = nextId('rh')
        addRecord({
          id: recordId, kind: 'release', version: releaseRound, target: releaseTarget,
          ...(baseVersion === undefined ? {} : { baseVersion }),
          createdAt: Date.now(), sessionId, status: 'active', content: releaseArchive,
        })
        controller.trackRecord(recordId, sessionId)
        setOpen(false)
      },
      (reason: unknown) => {
        setReleaseStarting(false)
        setReleaseError(`开始部署失败：${reason instanceof Error ? reason.message : String(reason)}`)
      },
    )
  }, [
    controller, releaseContext, releaseArchive, liveSessionId,
    addRecord, releaseRound, baseVersion, releaseTarget,
  ])

  const toggleChecked = useCallback((name: string) => {
    setChecked((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const openTable = openTableId === null ? undefined : requirements.find(item => item.id === openTableId)
  const isInfoPhase = activePhase?.id === 'info'
  const isFeaturePhase = activePhase?.id === 'feature'
  const isPrototypePhase = activePhase?.id === 'prototype'
  const isDevelopPhase = activePhase?.id === 'develop'
  const isTestPhase = activePhase?.id === 'test'
  const isReleasePhase = activePhase?.id === 'release'

  return (
    <XggLocaleContext.Provider value={t}>
      <div className={css.root}>
        <button
          type="button"
          className={css.toggle}
          aria-expanded={open}
          aria-controls="xgg-cycle-popup"
          onClick={() => { setOpen(current => !current) }}
        >
          {open ? t('copy.066') : t('copy.067')}
        </button>
        {open && (
          <div id="xgg-cycle-popup" className={css.panel} role="dialog" aria-label={t('copy.068')}>
            <aside className={css.menu} aria-label={t('copy.069')}>
              <div className={css.menuTitle}>{t('copy.069')}</div>
              <nav>
                {PHASES.map(phase => (
                  <button
                    key={phase.id}
                    type="button"
                    className={phase.id === phaseId ? css.menuItemActive : css.menuItem}
                    aria-current={phase.id === phaseId ? 'step' : undefined}
                    onClick={() => { setPhaseId(phase.id) }}
                  >
                    {phase.label}
                  </button>
                ))}
              </nav>
            </aside>
            <section className={css.body} aria-labelledby="xgg-cycle-phase-title">
              <LoopBanner
                loop={loop}
                onStart={() => { controller.runToPrototype() }}
                onResumeDevelop={() => { controller.runFromDevelop() }}
                onStop={() => { controller.stopLoop() }}
                onDismiss={askDismissLoop}
              />
              <div id="xgg-cycle-phase-title" className={css.phaseTitle}>{activePhase?.label}</div>

              {isInfoPhase
                ? (
                  <div className={css.featurePane}>
                    <div className={css.addRow}>
                      <input type="text" className={css.input} placeholder={t('copy.070')} value={infoKey} onChange={(event) => { setInfoKey(event.target.value) }} />
                      <input type="text" className={css.input} placeholder={t('copy.071')} value={infoValue} onChange={(event) => { setInfoValue(event.target.value) }} />
                      <button type="button" className={css.addButton} onClick={addInfo}>{t('copy.072')}</button>
                    </div>
                    {info.length === 0
                      ? <div className={css.empty}>{t('copy.073')}</div>
                      : (
                        <ul className={css.list}>
                          {info.map(entry => (
                            <li key={entry.id} className={css.listItem}>
                              <span className={css.infoKey}>{entry.key}</span>
                              <span className={css.infoColon}>:</span>
                              <span className={css.itemText}>{entry.value}</span>
                              <button type="button" className={css.removeButton} aria-label={t('copy.022', { p0: entry.key })} onClick={() => { askRemoveInfo(entry.id) }}>✕</button>
                            </li>
                          ))}
                        </ul>
                      )}
                  </div>
                )
                : activePhase?.id === 'requirement'
                  ? (
                    <div className={css.requirementPane}>
                      <div className={css.addRow}>
                        <input type="text" className={css.input} value={draft} placeholder={t('copy.074')} onChange={(event) => { setDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') addRequirement() }} />
                        <button type="button" className={css.addButton} onClick={addRequirement}>{t('copy.072')}</button>
                      </div>
                      {requirements.length === 0
                        ? <div className={css.empty}>{t('copy.075')}</div>
                        : (
                          <ul className={css.list}>
                            {requirements.map(item => (
                              <li key={item.id} className={css.listItem}>
                                <span className={css.itemText}>
                                  {item.text}
                                  {item.error !== undefined && <span className={css.itemError}>{item.error}</span>}
                                </span>
                                <div className={css.itemActions}>
                                  {item.expanded
                                    ? <button type="button" className={css.openButton} onClick={() => { openRequirement(item) }}>{t('copy.076')}</button>
                                    : (
                                      <button type="button" className={css.expandButton} disabled={item.expanding === true} onClick={() => { expandRequirement(item.id) }}>
                                        {item.expanding === true ? t('copy.077') : t('copy.078')}
                                      </button>
                                    )}
                                  <button type="button" className={css.removeButton} aria-label={t('copy.079')} onClick={() => { askRemoveRequirement(item.id) }}>✕</button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                    </div>
                  )
                  : isFeaturePhase
                    ? (
                      <div className={css.featurePane}>
                        {groups.length === 0
                          ? <div className={css.empty}>{t('copy.080')}</div>
                          : (
                            <div className={css.groupList}>
                              {groups.map(group => (
                                <section key={group.reqId} className={css.reqGroup}>
                                  <header className={css.reqGroupHeader}>
                                    <span className={css.reqGroupTitle}>{t('copy.081')}{group.reqText}」</span>
                                    <button type="button" className={css.removeButton} aria-label={t('copy.082')} onClick={() => { askRemoveGroup(group.reqId) }}>✕</button>
                                  </header>
                                  <GroupedEditor
                                    modules={group.modules}
                                    checked={checked}
                                    checkable={false}
                                    onToggle={toggleChecked}
                                    onAddModule={(name) => { addGroupModule(group.reqId, name) }}
                                    onAddPoint={(moduleId, point) => { addGroupPoint(group.reqId, moduleId, point) }}
                                    onRemovePoint={(name) => { askRemoveGroupPoint(group.reqId, name) }}
                                    onRemoveModule={(moduleId) => { askRemoveGroupModule(group.reqId, moduleId) }}
                                  />
                                </section>
                              ))}
                            </div>
                          )}
                      </div>
                    )
                    : isPrototypePhase
                      ? (
                        <HandOffPane
                          description={t('copy.083', { p0: nextPrototypeVersion })}
                          controls={(
                            <div className={css.modeRow} role="radiogroup" aria-label={t('copy.084')}>
                              {PROTOTYPE_MODES.map(item => (
                                <button
                                  key={item.id}
                                  type="button"
                                  role="radio"
                                  aria-checked={item.id === mode}
                                  className={item.id === mode ? css.modeCardActive : css.modeCard}
                                  onClick={() => { setMode(item.id) }}
                                >
                                  <span className={css.modeLabel}>{item.label}</span>
                                  <span className={css.modeHint}>{item.hint}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          actionLabel={t('copy.085')}
                          busyLabel={t('copy.086')}
                          busy={starting}
                          error={startError}
                          extra={extra}
                          onExtraChange={setExtra}
                          onClearExtra={() => { askClearExtra('原型', () => { setExtra('') }) }}
                          extraPlaceholder={t('copy.087')}
                          context={prototypeContext}
                          onStart={startPrototype}
                          records={prototypeRecords}
                          recordsEmptyText={t('copy.088')}
                          onStatusChange={setRecordStatus}
                          onRemove={askRemoveRecord}
                          onContinue={continueRound}
                        />
                      )
                      : isDevelopPhase
                        ? (
                          <HandOffPane
                            description={devTargetLive
                              ? t('copy.089', { p0: baseVersion ?? 0 })
                              : t('copy.090')}
                            controls={(
                              <div className={css.targetNotice}>
                                {devTargetLive
                                  ? t('copy.091', { p0: baseVersion ?? 0, p1: devRound })
                                  : t('copy.092', { p0: devRound })}
                              </div>
                            )}
                            actionLabel={t('copy.093')}
                            busyLabel={t('copy.034')}
                            busy={devStarting}
                            error={devError}
                            extra={devExtra}
                            onExtraChange={setDevExtra}
                            onClearExtra={() => { askClearExtra('开发', () => { setDevExtra('') }) }}
                            extraPlaceholder={t('copy.094')}
                            context={developContext}
                            onStart={startDevelop}
                            records={developRecords}
                            recordsEmptyText={t('copy.095')}
                            onStatusChange={setRecordStatus}
                            onRemove={askRemoveRecord}
                            onContinue={continueRound}
                          />
                        )
                        : isTestPhase
                          ? (
                            <HandOffPane
                              description={devTargetLive
                                ? t('copy.096', { p0: baseVersion ?? 0 })
                                : t('copy.097')}
                              controls={(
                                <div className={css.targetNotice}>
                                  {devTargetLive
                                    ? t('copy.098', { p0: baseVersion ?? 0, p1: testRound, p2: openBugs.length === 0 ? '' : ` · 带 ${openBugs.length} 条待办问题` })
                                    : t('copy.092', { p0: testRound })}
                                </div>
                              )}
                              actionLabel={t('copy.099')}
                              busyLabel={t('copy.034')}
                              busy={testStarting}
                              error={testError}
                              extra={testExtra}
                              onExtraChange={setTestExtra}
                              onClearExtra={() => { askClearExtra('测试', () => { setTestExtra('') }) }}
                              extraPlaceholder={t('copy.100')}
                              context={testContext}
                              onStart={startTest}
                              sections={(
                                <BugBoard
                                  bugs={bugs}
                                  onAdd={addBug}
                                  onStatusChange={setBugStatus}
                                  onRemove={askRemoveBug}
                                  checked={checkedBugs}
                                  onToggle={toggleBug}
                                  fixContext={fixContext}
                                  onStartFix={startFix}
                                  fixBusy={fixStarting}
                                  fixError={fixError}
                                />
                              )}
                              records={testRecords}
                              recordsEmptyText={t('copy.101')}
                              onStatusChange={setRecordStatus}
                              onRemove={askRemoveRecord}
                              onContinue={continueRound}
                            />
                          )
                          : isReleasePhase
                            ? (
                              <HandOffPane
                                description={devTargetLive
                                  ? t('copy.102', { p0: baseVersion ?? 0 })
                                  : t('copy.103')}
                                controls={(
                                  <div className={css.modeRow} role="radiogroup" aria-label={t('copy.104')}>
                                    {RELEASE_TARGETS.map(item => (
                                      <button
                                        key={item.id}
                                        type="button"
                                        role="radio"
                                        aria-checked={item.id === releaseTarget}
                                        className={item.id === releaseTarget ? css.modeCardActive : css.modeCard}
                                        onClick={() => { setReleaseTarget(item.id) }}
                                      >
                                        <span className={css.modeLabel}>{item.label}</span>
                                        <span className={css.modeHint}>{item.hint}</span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                                actionLabel={t('copy.105')}
                                busyLabel={t('copy.034')}
                                busy={releaseStarting}
                                error={releaseError}
                                extra={releaseExtra}
                                onExtraChange={setReleaseExtra}
                                onClearExtra={() => { askClearExtra('上线', () => { setReleaseExtra('') }) }}
                                extraPlaceholder={t('copy.106')}
                                context={releaseContext}
                                onStart={startRelease}
                                sections={releaseTarget === 'server'
                                  ? (
                                    <ServerForm
                                      server={server}
                                      onChange={patchServer}
                                      password={password}
                                      onPasswordChange={setPassword}
                                    />
                                  )
                                  : undefined}
                                records={releaseRecords}
                                recordsEmptyText={t('copy.107')}
                                onStatusChange={setRecordStatus}
                                onRemove={askRemoveRecord}
                                onContinue={continueRound}
                              />
                            )
                            : (
                              <>
                                <p className={css.phaseDescription}>{activePhase?.description}</p>
                                <div className={css.placeholder}>{t('copy.108')}{activePhase?.label}{t('copy.109')}</div>
                              </>
                            )}
            </section>
          </div>
        )}

        {/* Layered above the expansion modal: a delete can be triggered from
          inside it, so this must sit on top of it. */}
        {pending !== null && (
          <div className={css.confirmBackdrop}>
            <div className={css.confirmDialog} role="alertdialog" aria-modal="true" aria-label={pending.title}>
              <div className={css.modalHeader}>
                <div className={css.modalTitle}>{pending.title}</div>
                <div className={css.confirmDetail}>{pending.detail}</div>
              </div>
              <div className={css.modalFooter}>
                <button
                  type="button"
                  className={css.dangerButton}
                  onClick={() => {
                    pending.run()
                    setPending(null)
                  }}
                >
                  {t('copy.110')}</button>
                <button type="button" className={css.cancelButton} onClick={() => { setPending(null) }}>{t('copy.013')}</button>
              </div>
            </div>
          </div>
        )}

        {openTable !== undefined && (
          <div className={css.modalBackdrop}>
            <div className={css.modal} role="dialog" aria-modal="true" aria-label={t('copy.111')}>
              <div className={css.modalHeader}>
                <div className={css.modalTitle}>{t('copy.111')}</div>
                <div className={css.modalSubtitle}>{openTable.text}{t('copy.112')}</div>
              </div>
              <div className={css.modalBody}>
                <GroupedEditor
                  modules={openTable.modules}
                  checked={checked}
                  checkable
                  onToggle={toggleChecked}
                  onAddModule={openReqAddModule}
                  onAddPoint={openReqAddPoint}
                  onRemovePoint={() => {}}
                  onRemoveModule={() => {}}
                />
              </div>
              <div className={css.modalFooter}>
                <button type="button" className={css.confirmButton} onClick={confirmRequirement}>{t('copy.113')}</button>
                <button type="button" className={css.cancelButton} onClick={() => { setOpenTableId(null); setChecked(new Set()) }}>{t('copy.013')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </XggLocaleContext.Provider>
  )
}
