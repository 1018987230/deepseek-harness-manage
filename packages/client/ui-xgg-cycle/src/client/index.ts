/**
 * Web xgg-cycle plugin, browser half: a right-aligned session utility that
 * toggles a large (~90% viewport) workflow panel.
 *
 * The panel itself is a view; everything it remembers and the automatic loop
 * that drives it live in the root-scope controller (controller.ts), because a
 * dispatch that waits for a reply must select its session — which unmounts the
 * session-scoped copy of this very panel.
 *
 * Export discipline: packages/client/AGENTS.md.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: carries the owner of 'conversation.session.header.utilities'
// (ui-conversation) so PropsRuntime resolves that SlotMap entry, and merges
// `ctx.conversation` (the session-addressed input resolver) into Context.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: carries ui-sidebar's 'sidebar.footer.action' declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createPanelController } from './controller.ts'
import { PopupPanel, type PopupPanelInjected } from './PopupPanel.tsx'
import { en, zh, type XggCycleKey } from './locale.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** xgg-cycle workflow panel copy. */
    xggCycle: XggCycleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'xggCycle'

/**
 * Required services: the slot registry, plus the two domains the hand-off
 * drives (Workspace-scoped session creation and session selection). React is a
 * shell-seeded static; `conversation` is resolved softly off the target
 * session's scope, so it stays out of this list.
 */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale']

/**
 * Client plugin body: register the workflow toggle into the session header's
 * right-aligned utilities. The slot is declared by ui-conversation;
 * `slots.inject` waits on that declaration, removes the contribution if it
 * collapses, and leaves with this plugin's fiber.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-xgg-cycle: dictionaries')
  const controller = createPanelController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-xgg-cycle: panel controller')
  const injectProps = (): PopupPanelInjected => ({ controller })

  // Registered twice on purpose. The session header is where the button
  // belongs, but a blank session hides its whole header chrome
  // (ConversationSession's `hideChrome`), so a freshly created Workspace would
  // have no way in at all. The root-scope sidebar foot always renders.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    {
      name: 'conversation.session.header.utilities',
      id: 'xgg-cycle',
      locale: NS,
      inject: injectProps,
    },
    PopupPanel,
  ))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'xgg-cycle',
      locale: NS,
      inject: injectProps,
    },
    PopupPanel,
  ))
}
