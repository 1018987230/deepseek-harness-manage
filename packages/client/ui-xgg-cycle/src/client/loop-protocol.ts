/**
 * The wire protocol between the panel's automatic loop and the session driving
 * it: the prompts that ask for a machine-readable answer, and the tolerant
 * parsers that read one back.
 *
 * Everything here is pure — no React, no services — so the shapes stay easy to
 * reason about and the loop in PopupPanel stays about sequencing.
 */
import { extractJsonObjects } from './session-ask.ts'

/** Priority/severity tier shared by feature points and bugs. */
export type Tier = 'P0' | 'P1' | 'P2'

/** One generated feature point. */
export interface ParsedPoint {
  name: string
  priority: Tier
  description: string
}

/** One generated module and its points. */
export interface ParsedModule {
  name: string
  points: ParsedPoint[]
}

/** One requirement's generated expansion, echoed back with its index. */
export interface ParsedRequirement {
  index: number
  modules: ParsedModule[]
}

/** One problem the test round reported. */
export interface ParsedBug {
  title: string
  severity: Tier
  detail: string
}

/** The structured tail of a test report. */
export interface ParsedReport {
  bugs: ParsedBug[]
}

/** One problem a fix round could not close, and why. */
export interface ParsedUnfixed {
  title: string
  reason: string
}

/** The structured tail of a fix round. */
export interface ParsedFixOutcome {
  fixed: string[]
  unfixed: ParsedUnfixed[]
}

function isTier(value: unknown): value is Tier {
  return value === 'P0' || value === 'P1' || value === 'P2'
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The most recent JSON object in a reply that carries `key`.
 *
 * Protocol objects are found by their key, never by position: a round's reply
 * is full of incidental JSON (a package.json it echoed, a config it showed),
 * and the object we asked for may sit anywhere among them.
 * @param reply - the assistant text.
 * @param key - the field that identifies the object.
 * @returns that object, or undefined when no payload carries the key.
 */
function findObjectWith(reply: string, key: string): Record<string, unknown> | undefined {
  for (const candidate of extractJsonObjects(reply)) {
    const record = asRecord(candidate)
    if (record !== undefined && key in record) return record
  }
  return undefined
}

/**
 * The most recent JSON payload that is either a bare array or an object
 * carrying `key` (whose value is the array).
 * @param reply - the assistant text.
 * @param key - the field the array sits under when wrapped.
 * @returns the array, or undefined when nothing matches.
 */
function findArrayWith(reply: string, key: string): unknown[] | undefined {
  const candidates = extractJsonObjects(reply)
  // Keyed objects first: a bare array anywhere in the reply (an example, a
  // config fragment) must never outrank the object we actually asked for.
  for (const candidate of candidates) {
    const record = asRecord(candidate)
    if (record !== undefined && Array.isArray(record[key])) return record[key] as unknown[]
  }
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as unknown[]
  }
  return undefined
}

/**
 * The instruction block appended to every prompt that must answer in JSON.
 * @param shape - a one-line example of the expected object.
 * @returns the instruction lines.
 */
export function jsonContract(shape: string): string[] {
  return [
    '',
    '【输出格式】（必须严格遵守）',
    '在回复的最后输出一个 json 代码块（用三个反引号包起来，语言标注写 json），',
    '块内是且只是一个合法 JSON 对象，不要加注释、不要用尾随逗号。格式：',
    shape,
  ]
}

/**
 * Read the round-completion marker.
 *
 * A round is not a turn: development gets interrupted, the user says 继续, and
 * only some later turn finishes the job. So completion is what the session
 * DECLARES, never the turn boundary — settling on the boundary would mark a
 * half-built project done and let the next phase build on it.
 *
 * Absent or unparsable is deliberately NOT read as complete: the safe failure
 * is to keep waiting (the user can settle it by hand), not to march on.
 * @param reply - the assistant text.
 * @returns true only when the reply says the round is finished.
 */
export function parseRoundComplete(reply: string): boolean {
  return findObjectWith(reply, 'roundComplete')?.roundComplete === true
}

/**
 * Read the expansion reply.
 *
 * Tolerant by design: a model that returns the array bare, or wraps it under a
 * different key, still produces usable output rather than failing the round.
 * Entries missing a usable name are dropped instead of poisoning the board.
 * @param reply - the assistant text.
 * @returns one entry per requirement it answered for; empty when unparsable.
 */
export function parseExpansion(reply: string): ParsedRequirement[] {
  const raw = findArrayWith(reply, 'requirements')
  if (raw === undefined) return []

  const out: ParsedRequirement[] = []
  for (const [position, item] of raw.entries()) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    const modulesRaw = Array.isArray(entry.modules) ? entry.modules : []
    const modules: ParsedModule[] = []
    for (const moduleItem of modulesRaw) {
      const moduleEntry = asRecord(moduleItem)
      if (moduleEntry === undefined) continue
      const name = asString(moduleEntry.name).trim()
      if (name === '') continue
      const pointsRaw = Array.isArray(moduleEntry.points) ? moduleEntry.points : []
      const points: ParsedPoint[] = []
      for (const pointItem of pointsRaw) {
        const pointEntry = asRecord(pointItem)
        if (pointEntry === undefined) continue
        const pointName = asString(pointEntry.name).trim()
        if (pointName === '') continue
        points.push({
          name: pointName,
          priority: isTier(pointEntry.priority) ? pointEntry.priority : 'P2',
          description: asString(pointEntry.description).trim(),
        })
      }
      if (points.length > 0) modules.push({ name, points })
    }
    if (modules.length === 0) continue
    const index = typeof entry.index === 'number' ? entry.index : position + 1
    out.push({ index, modules })
  }
  return out
}

/**
 * Read the feature-point names a 开发 round reported as finished.
 * @param reply - the assistant text.
 * @returns the names, or undefined when no payload carried the key.
 */
export function parseCompletedPoints(reply: string): string[] | undefined {
  const raw = findArrayWith(reply, 'completedPoints')
  if (raw === undefined) return undefined
  const names: string[] = []
  for (const item of raw) {
    const name = asString(item).trim()
    if (name !== '') names.push(name)
  }
  return names
}

/**
 * Read the structured tail of a fix round.
 *
 * Closes the automation loop: without it every dispatched problem stays 修复中
 * forever and the board can never reach empty, so nothing downstream can tell a
 * fixed project from an unfixed one.
 *
 * Tolerant on `unfixed`: a bare string is accepted as a title with no reason,
 * because that is the shape a model slips into most often.
 * @param reply - the assistant text.
 * @returns the outcome, or undefined when nothing parsed.
 */
export function parseFixOutcome(reply: string): ParsedFixOutcome | undefined {
  const root = findObjectWith(reply, 'fixed') ?? findObjectWith(reply, 'unfixed')
  if (root === undefined) return undefined

  const fixed: string[] = []
  for (const item of Array.isArray(root.fixed) ? root.fixed : []) {
    const title = asString(item).trim()
    if (title !== '') fixed.push(title)
  }
  const unfixed: ParsedUnfixed[] = []
  for (const item of Array.isArray(root.unfixed) ? root.unfixed : []) {
    if (typeof item === 'string') {
      const title = item.trim()
      if (title !== '') unfixed.push({ title, reason: '' })
      continue
    }
    const entry = asRecord(item)
    if (entry === undefined) continue
    const title = asString(entry.title).trim()
    if (title !== '') unfixed.push({ title, reason: asString(entry.reason).trim() })
  }
  return { fixed, unfixed }
}

/**
 * Read the structured tail of a test report.
 *
 * A report with no JSON block at all is NOT read as "zero bugs" — that would
 * silently end the loop on a formatting slip. The caller distinguishes the two
 * through the undefined return.
 * @param reply - the assistant text.
 * @returns the parsed bug list, or undefined when nothing parsed.
 */
export function parseReport(reply: string): ParsedReport | undefined {
  const raw = findArrayWith(reply, 'bugs')
  if (raw === undefined) return undefined

  const bugs: ParsedBug[] = []
  for (const item of raw) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    const title = asString(entry.title).trim()
    if (title === '') continue
    bugs.push({
      title,
      severity: isTier(entry.severity) ? entry.severity : 'P2',
      detail: asString(entry.detail).trim(),
    })
  }
  return { bugs }
}
