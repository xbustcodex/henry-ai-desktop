/**
 * Discord REST client.
 *
 * Built entirely against Discord's documented public API — no proprietary
 * hosted backend, no paid Henry service. Discord's v10 REST surface is what a
 * bot or a user token talks to, and both are supported because the stored
 * credential records which kind it is (`authScheme`):
 *
 *   - Bot token  → `Authorization: Bot <token>`. Sees every server the bot was
 *     invited to. This is the normal setup.
 *   - User token → `Authorization: <token>` (no scheme). Sees what the user
 *     sees, obtained through the same PKCE flow as every other provider.
 *
 * Discord rate-limits per route and answers 429 with `retry_after`. The client
 * surfaces that rather than hammering: `apiRequest` returns the 429 and the
 * tools report the wait, because silently sleeping inside a tool call is how an
 * agent turns one rate-limited route into a stalled turn.
 */

import type Database from 'better-sqlite3';
import { apiRequest, type ApiResponse } from '../httpClient';
import { DISCORD_PROVIDER } from '../oauth/registry';

const BASE = 'https://discord.com/api/v10';

/** Discord refuses message content above 2000 characters. */
export const MAX_MESSAGE_LENGTH = 2000;

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
  owner?: boolean;
  permissions?: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  guild_id?: string;
  topic?: string | null;
  parent_id?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: DiscordUser;
  attachments?: Array<{ id: string; filename: string; size: number }>;
  embeds?: unknown[];
}

/** Channel type constants Henry actually needs to reason about. */
const CHANNEL_TYPE_NAMES: Record<number, string> = {
  0: 'text',
  1: 'voice',
  2: 'voice',
  5: 'announcement',
  10: 'announcement_thread',
  11: 'public_thread',
  12: 'private_thread',
  13: 'private_thread',
  15: 'forum',
  16: 'media',
};

export function describeChannelType(type: number): string {
  return CHANNEL_TYPE_NAMES[type] ?? `type_${type}`;
}

export interface DiscordRequestOptions {
  db: Database.Database;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  fetchImpl?: typeof fetch;
}

/** The authenticated identity behind the stored credential. */
export function fetchCurrentUser(options: DiscordRequestOptions): Promise<ApiResponse<DiscordUser>> {
  return apiRequest<DiscordUser>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: '/users/@me',
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Every guild the credential can see. For a bot that is every server it was
 * invited to; for a user, every server they are a member of.
 */
export function fetchGuilds(options: DiscordRequestOptions): Promise<ApiResponse<DiscordGuild[]>> {
  return apiRequest<DiscordGuild[]>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: '/users/@me/guilds',
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** Channel list for one guild. Direct messages are not a guild. */
export function fetchGuildChannels(
  guildId: string,
  options: DiscordRequestOptions,
): Promise<ApiResponse<DiscordChannel[]>> {
  return apiRequest<DiscordChannel[]>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: `/guilds/${encodeURIComponent(guildId)}/channels`,
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** The user's DM channels. */
export function fetchDirectChannels(
  options: DiscordRequestOptions,
): Promise<ApiResponse<DiscordChannel[]>> {
  return apiRequest<DiscordChannel[]>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: '/users/@me/channels',
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Read recent messages. `before` is a message id and pages backwards, which is
 * how you read "the last 20" without pulling the whole channel.
 */
export function fetchMessages(
  channelId: string,
  limit: number,
  options: DiscordRequestOptions,
  before?: string,
): Promise<ApiResponse<DiscordMessage[]>> {
  return apiRequest<DiscordMessage[]>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: `/channels/${encodeURIComponent(channelId)}/messages`,
    query: { limit, before },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Send a message. This is the only Discord call that has an effect outside the
 * machine, so every caller gates it on the confirm tier — but the guard lives
 * in the tool definition, not here, where it could be forgotten.
 */
export function sendMessage(
  channelId: string,
  content: string,
  options: DiscordRequestOptions,
): Promise<ApiResponse<DiscordMessage>> {
  return apiRequest<DiscordMessage>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: `/channels/${encodeURIComponent(channelId)}/messages`,
    method: 'POST',
    body: { content },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/** Open (or reuse) the DM channel with a user. Needed before sending a DM. */
export function openDirectChannel(
  recipientId: string,
  options: DiscordRequestOptions,
): Promise<ApiResponse<DiscordChannel>> {
  return apiRequest<DiscordChannel>({
    provider: DISCORD_PROVIDER,
    baseUrl: BASE,
    path: '/users/@me/channels',
    method: 'POST',
    body: { recipient_id: recipientId },
    db: options.db,
    fetchImpl: options.fetchImpl,
  });
}

/**
 * Discord's 429 body carries `retry_after` in seconds. Surfacing it lets the
 * tool explain the wait instead of appearing to hang.
 */
export function rateLimitHint(res: ApiResponse<unknown>): string | null {
  if (res.status !== 429) return null;
  const body = res.data as { retry_after?: number } | undefined;
  const seconds = Number(body?.retry_after);
  return Number.isFinite(seconds)
    ? `Discord rate-limited this route. Retry in ${seconds}s.`
    : 'Discord rate-limited this route.';
}

/** Trim a message to Discord's hard limit rather than letting it 400. */
export function clampMessage(content: string): string {
  return content.length > MAX_MESSAGE_LENGTH ? content.slice(0, MAX_MESSAGE_LENGTH) : content;
}