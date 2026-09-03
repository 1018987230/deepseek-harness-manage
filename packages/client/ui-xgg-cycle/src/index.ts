/**
 * Web xgg-cycle plugin, node half.
 *
 * Deliberately empty. The workflow panel is a pure browser surface (a
 * session-header occupant) whose requirement expansion currently runs on
 * frontend-local mock data; this node half exists only so the package appears
 * in the host Loader and its browser half is discovered through the
 * package.json `dsh.client` manifest.
 */

/** Host plugin body — no host capability, nothing to compose here. */
export function apply(): void {}
