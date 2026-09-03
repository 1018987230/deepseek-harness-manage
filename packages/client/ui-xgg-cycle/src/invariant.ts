/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-xgg-cycle`.
 * @module @deepseek-ai/dsh-client-ui-xgg-cycle/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-xgg-cycle'

/** Cordis companion plugin name. */
export const name = 'client-ui-xgg-cycle-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the slot registration is an effect owned and
 * observed by the slot registry; there is no host pending table for this
 * pure-presentation surface.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
