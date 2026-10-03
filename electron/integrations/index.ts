/**
 * Henry's integration layer — one place for every third-party service.
 *
 * Layout:
 *   oauth/        the provider-agnostic PKCE engine, credential store, registry
 *   httpClient    authenticated request with refresh-on-401
 *   google/       Gmail + Drive + Calendar tools against the stored Google token
 *   discord/      Discord REST tools against a bot or user token
 *   ipc.ts        one set of `integration:*` channels for every provider
 *
 * `integrationTools()` is the single registration point the agent's tool index
 * calls, so adding a provider means adding a folder here — not touching
 * `electron/agent/tools/index.ts` again.
 */

import type { ToolDefinition } from '../agent/types';
import type { ToolRegistry } from '../agent/toolRegistry';
import { discordTools } from './discord/tools';
import { googleTools } from './google/tools';
import { registerIntegrationHandlers } from './ipc';

export { registerIntegrationHandlers } from './ipc';
export { googleTools } from './google/tools';
export { discordTools } from './discord/tools';
export { getProvider, listProviderIds, GOOGLE_PROVIDER, DISCORD_PROVIDER } from './oauth/registry';
export { describeCredential } from './oauth/credentialStore';
export { connect, disconnect, ensureAccessToken, redact } from './oauth/flow';

/** Every tool the integration layer contributes to the agent. */
export function integrationTools(): ToolDefinition[] {
  return [...googleTools(), ...discordTools()];
}

/**
 * Register the integration tools against the agent's tool registry.
 *
 * Deliberately additive: the registry is last-wins per name, and these names
 * are all prefixed (`gmail_`, `drive_`, `gcal_`, `google_`, `discord_`), so
 * this can never displace an existing tool.
 */
export function registerIntegrationTools(registry: ToolRegistry): void {
  registry.registerAll(integrationTools());
}