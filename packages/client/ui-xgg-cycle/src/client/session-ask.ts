/**
 * Dispatch-and-wait against one session, plus the structured-reply parsing the
 * automatic loop needs.
 *
 * Addressed by session id and used for both the manual and the automatic
 * dispatches. The caller selects the session first: a session whose window was
 * never opened drops its own live events (Session.acceptLiveEvent bails while
 * openState !== 'open'), so a reply would never arrive here.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionBinding, SessionEventLikeEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

/** The slice of a session face both waiters read. */
type SessionWatchFace = Pick<SessionBinding, 'session' | 'eventSource'>

/**
 * How long a RUNNING turn may go without any observable change before the wait
 * gives up on it. Inactivity, not total duration: a build that streams tool
 * calls for an hour is healthy, one that has printed nothing for twenty
 * minutes is stuck. While no turn is running the timer is not armed at all —
 * an idle wait for the user's next 继续 must be able to outlast a lunch break.
 */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/** Fence marker delimiting a code block in the assistant's reply. */
const FENCE = '```'

/**
 * Highest event seq currently visible in a session, used as the "everything
 * after this is my answer" watermark.
 * @param nodes - the session's conversation nodes.
 * @returns the highest seq, or -1 for an empty window.
 */
function highestSeq(entries: readonly SessionEventLikeEntry[]): number {
  return entries.reduce((max, entry) => entry.type === 'event'
    ? Math.max(max, entry.event.seq)
    : max, -1)
}

/** What one settled turn produced, and how the wait decided it was settled. */
interface TurnOutcome {
  /** Concatenated text blocks of the turn's assistant messages. */
  text: string
  /** True when a fresh assistant message was observed (not just a running dip). */
  answered: boolean
}

/**
 * Resolve once the session's current turn has settled.
 *
 * Two independent completion signals, because neither alone is sufficient:
 *   - a fresh assistant message past the watermark while nothing is running or
 *     streaming — the normal case, and the only one that yields text;
 *   - a running → not-running transition — the fallback for a turn that ends
 *     without adding an assistant message (cancelled, errored, tool-only).
 * Both are additionally gated on an empty queue. `running: false` on its own is
 * NOT completion: a turn that has not started yet reports exactly that, and so
 * does the gap between two turns of a session running a queue.
 *
 * The timeout measures inactivity during a running turn and is re-armed on
 * every snapshot change; it is disarmed entirely while nothing runs.
 * @param session - the session's snapshot face.
 * @param watermark - highest seq that predates the message being awaited.
 * @param signal - aborts the wait.
 * @param timeoutMs - longest silence tolerated inside a running turn.
 * @returns the settled turn.
 */
function awaitTurn(
  session: SessionWatchFace,
  watermark: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('已取消'))
      return
    }
    let settled = false
    let sawRunning = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // One disposer list keeps teardown order-independent, so every listener can
    // be registered as a const after the handler that tears it down is defined.
    const disposers: (() => void)[] = []
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      for (const dispose of disposers) dispose()
      finish()
    }
    const disarm = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    }
    const rearm = () => {
      disarm()
      timer = setTimeout(
        () => { settle(() => { reject(new Error('会话在回合中途停止响应，等待超时')) }) },
        timeoutMs,
      )
    }
    const check = () => {
      if (settled) return
      const snapshot = session.session.getSnapshot()
      if (snapshot.running) {
        sawRunning = true
        // Something changed while running: the turn is alive, push the deadline.
        rearm()
        return
      }
      // Not running: nothing to time out. An idle wait is bounded by the
      // caller's abort signal, never by silence.
      disarm()
      // Still-queued work means our round has not run yet — the phases after
      // 原型 reuse one session, so a round dispatched while the previous turn
      // is still going sits in the queue, and settling on THAT turn's end would
      // mark this round finished before it ever started.
      if (snapshot.queue.length > 0) return
      // Collected in a loop rather than filter+flatMap: the union narrowing
      // that gives `blocks` its type does not survive an array method chain.
      const texts: string[] = []
      let fresh = 0
      for (const entry of session.eventSource.getSnapshot().entries) {
        if (entry.type !== 'event') continue
        const event = entry.event
        if (event.type !== 'assistant/message' || event.seq <= watermark) continue
        fresh += 1
        for (const block of event.data.message.content) {
          if (block.type === 'text') texts.push(block.text)
        }
      }
      if (fresh === 0 && !sawRunning) return
      settle(() => { resolve({ text: texts.join('\n').trim(), answered: fresh > 0 }) })
    }
    const onAbort = () => { settle(() => { reject(new Error('已取消')) }) }

    disposers.push(disarm)
    signal.addEventListener('abort', onAbort)
    disposers.push(() => { signal.removeEventListener('abort', onAbort) })
    disposers.push(session.session.subscribe(check))
    disposers.push(session.eventSource.subscribe(check))
    // The turn may already have settled between submit and subscribe.
    check()
  })
}

/**
 * Deliver `text` to one session and resolve with the assistant text that turn
 * produced.
 * @param ctx - client root context.
 * @param sessionId - the session to prompt (already selected by the caller).
 * @param text - the message to send.
 * @param signal - aborts the wait.
 * @param timeoutMs - upper bound on one turn.
 * @returns the concatenated text blocks of the turn's assistant messages.
 */
export async function askSession(
  ctx: Context,
  sessionId: SessionId,
  text: string,
  signal: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) throw new Error(`会话 ${sessionId} 没有解析出绑定`)
  const conversation = binding.ctx.get('conversation')
  if (conversation === undefined) throw new Error('会话服务不可用，无法投递消息')

  const watermark = highestSeq(binding.eventSource.getSnapshot().entries)

  const input = conversation.input.for(binding.ctx)
  input.setDraft(text)
  input.submit()

  const outcome = await awaitTurn(binding, watermark, signal, timeoutMs)
  return outcome.text
}

/**
 * Wait for a turn already in flight in `sessionId` to finish.
 *
 * The fire-and-forget dispatches (the phase buttons) need this: they record a
 * round as 进行中 and nothing would ever move it off that, because unlike the
 * loop they never awaited the reply. The text comes back because a turn ending
 * is not a round ending — the caller reads the completion marker out of it.
 * @param ctx - client root context.
 * @param sessionId - the session whose turn to await.
 * @param signal - aborts the wait.
 * @param timeoutMs - upper bound on one turn.
 * @returns the assistant text of that turn.
 */
export async function awaitSessionTurn(
  ctx: Context,
  sessionId: SessionId,
  signal: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) throw new Error(`会话 ${sessionId} 没有解析出绑定`)
  // Taken after the caller submitted, so the user message is already in the
  // window; only the assistant reply can land past this mark.
  const watermark = highestSeq(binding.eventSource.getSnapshot().entries)
  return (await awaitTurn(binding, watermark, signal, timeoutMs)).text
}

/**
 * Every parseable JSON payload in an assistant reply, last fence first.
 *
 * All of them, not just the last: a build round echoes package.json, tsconfig
 * and the like — valid JSON that would shadow the protocol object if a reader
 * stopped at the first parse that succeeded. Each parser scans this list for
 * the object carrying ITS key instead. Deliberately string-scanned rather than
 * regex-matched: the info string after the opening fence varies (`json`,
 * `JSON`, nothing at all) and a tolerant scan beats a brittle pattern.
 * @param reply - the assistant text.
 * @returns parsed payloads, most recent first; the whole reply as a final try.
 */
export function extractJsonObjects(reply: string): unknown[] {
  const found: unknown[] = []
  const parts = reply.split(FENCE)
  // Fenced bodies sit at odd indices: [before, body, between, body, after].
  for (let index = parts.length - 2; index >= 1; index -= 2) {
    const body = parts[index] ?? ''
    const firstBreak = body.indexOf('\n')
    const payload = firstBreak === -1 ? body : body.slice(firstBreak + 1)
    try {
      found.push(JSON.parse(payload.trim()))
    } catch {
      // Not JSON — a code sample or prose; keep walking backwards.
    }
  }
  try {
    found.push(JSON.parse(reply.trim()))
  } catch {
    // The reply as a whole is prose; that is the normal case.
  }
  return found
}
