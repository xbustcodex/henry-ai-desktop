/**
 * Discord agent tools.
 *
 * Safety tiers follow the same rule the rest of the kit uses: anything that
 * leaves the machine pauses for the user.
 *
 *   discord_auth_status    silent  — reads local connection state, no API call
 *   discord_list_guilds    silent  — read
 *   discord_list_channels  silent  — read
 *   discord_read_messages  silent  — read
 *   discord_send_message   confirm — posts a real message to real people
 *
 * `discord_send_message` is confirm because a Discord message is a side effect
 * with a human on the other end: it notifies, it is archived, and Henry cannot
 * take it back. `discord_auth_status` is silent and local so the model can
 * check the connection before promising anything.
 *
 * Every tool returns a structured `not_connected` payload rather than throwing
 * when the user has not connected Discord, so the model relays the instruction
 * instead of reporting an opaque failure.
 */

import type { ToolDefinition, ToolResult, AgentContext } from '../../agent/types';
import type { ApiResponse } from '../httpClient';
import { describeCredential } from '../oauth/credentialStore';
import { DISCORD_PROVIDER } from '../oauth/registry';
import {
  clampMessage,
  describeChannelType,
  fetchCurrentUser,
  fetchDirectChannels,
  fetchGuildChannels,
  fetchGuilds,
  fetchMessages,
  openDirectChannel,
  rateLimitHint,
  sendMessage,
  MAX_MESSAGE_LENGTH,
} from './client';

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

/**
 * Standard "Discord isn't set up" payload — a successful read carrying the
 * instruction, so the model tells the user what to do next. Matches the
 * QuickBooks kit's convention for exactly this situation.
 */
function notConnected(): ToolResult {
  return ok({
    connected: false,
    status: 'not_connected',
    message:
      'Discord is not connected. Open Settings → Connections → Discord and paste a bot token ' +
      '(or connect a user account), then run this again.',
  });
}

/**
 * Turn an ApiResponse into a ToolResult, preserving rate-limit detail.
 *
 * Status 0 is `apiRequest`'s "no usable credential" signal, so it maps to the
 * actionable not-connected read rather than a generic failure — the model can
 * then tell the user exactly what to do.
 */
function fromApi(res: ApiResponse): ToolResult {
  if (res.ok) return ok(res.data);
  if (res.status === 0) return notConnected();
  const hint = rateLimitHint(res);
  return fail(hint ?? res.error ?? 'Discord request failed.', res.status === 429);
}

/**
 * A credential IS stored but Discord rejected it — revoked, or the bot was
 * removed from every server it was in. Distinct from "not connected": the fix
 * is a fresh token, not a first-time setup.
 */
function rejectedCredential(): ToolResult {
  return fail(
    'Discord rejected the stored token. It was revoked, or the bot was removed from every ' +
      'server. Disconnect and paste a fresh bot token.',
  );
}

function requiredString(value: unknown, field: string): string | ToolResult {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fail(`${field} is required.`);
  return text;
}

export function discordTools(): ToolDefinition[] {
  return [
    {
      name: 'discord_auth_status',
      description:
        'Report whether Discord is connected, without calling Discord. Use this before ' +
        'promising the user you can read or send Discord messages.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute(_params, context: AgentContext) {
        const status = describeCredential(DISCORD_PROVIDER.id, context.db);
        if (!status.connected) return notConnected();
        // Verifying the token actually works is a network call, but it is a
        // read, and a stored credential that has been revoked server-side is
        // the single most common confusing state — worth the round trip.
        const me = await fetchCurrentUser({ db: context.db });
        if (!me.ok || !me.data) {
          return ok({
            connected: true,
            usable: false,
            message:
              me.error ??
              'Discord is connected on this machine but the token was rejected. Reconnect Discord.',
          });
        }
        return ok({
          connected: true,
          usable: true,
          account: {
            id: me.data.id,
            username: me.data.username,
            displayName: me.data.global_name ?? me.data.username,
            isBot: Boolean(me.data.bot),
          },
          scope: status.scope,
        });
      },
    },

    // ── discord_list_guilds ─────────────────────────────────────────────
    {
      name: 'discord_list_guilds',
      description:
        'List the Discord servers (guilds) the connected account can see. Use this first ' +
        'when you need a server id for another Discord tool.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute(_params, context: AgentContext) {
        const res = await fetchGuilds({ db: context.db });
        if (!res.ok) {
          return res.status === 401 ? rejectedCredential() : fromApi(res);
        }
        return ok({
          count: res.data?.length ?? 0,
          guilds: (res.data ?? []).map((g) => ({
            id: g.id,
            name: g.name,
            owner: Boolean(g.owner),
          })),
        });
      },
    },

    // ── discord_list_channels ───────────────────────────────────────────
    {
      name: 'discord_list_channels',
      description:
        'List Discord channels. Pass a guildId for a server\'s channels, or omit it to list ' +
        'the account\'s direct-message channels.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          guildId: {
            type: 'string',
            description: 'Server (guild) id from discord_list_guilds. Omit for DMs.',
          },
        },
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const guildId = typeof params.guildId === 'string' ? params.guildId.trim() : '';
        const res = guildId
          ? await fetchGuildChannels(guildId, { db: context.db })
          : await fetchDirectChannels({ db: context.db });
        if (!res.ok) {
          if (res.status === 401) return rejectedCredential();
          if (res.status === 404 && guildId) {
            return fail(
              `Discord has no server with id "${guildId}". Use discord_list_guilds to get valid ids.`,
            );
          }
          return fromApi(res);
        }
        return ok({
          guildId: guildId || null,
          count: res.data?.length ?? 0,
          channels: (res.data ?? []).map((c) => ({
            id: c.id,
            name: c.name,
            type: describeChannelType(c.type),
            topic: c.topic ?? null,
          })),
        });
      },
    },

    // ── discord_read_messages ───────────────────────────────────────────
    {
      name: 'discord_read_messages',
      description:
        'Read the most recent messages in a Discord channel, newest last. Requires a ' +
        'channelId from discord_list_channels.',
      category: 'external',
      safetyLevel: 'silent',
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'Discord channel id.' },
          limit: {
            type: 'number',
            description: 'How many messages to read (default 20, max 100).',
          },
        },
        required: ['channelId'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const channelId = requiredString(params.channelId, 'channelId');
        if (typeof channelId !== 'string') return channelId;

        const requested = Number(params.limit ?? 20);
        const limit = Math.min(Math.max(Number.isFinite(requested) ? Math.trunc(requested) : 20, 1), 100);
        const res = await fetchMessages(channelId, limit, { db: context.db });
        if (!res.ok) {
          if (res.status === 401) return rejectedCredential();
          if (res.status === 403) {
            return fail(
              `No access to that channel. A bot can only read channels it was invited to, ` +
                `and needs the Message Content intent.`,
            );
          }
          if (res.status === 404) {
            return fail(`No Discord channel with id "${channelId}". Use discord_list_channels.`);
          }
          return fromApi(res);
        }
        return ok({
          channelId,
          count: res.data?.length ?? 0,
          messages: (res.data ?? []).map((m) => ({
            id: m.id,
            author: m.author.global_name ?? m.author.username,
            authorId: m.author.id,
            timestamp: m.timestamp,
            content: m.content,
            attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, size: a.size })),
          })),
        });
      },
    },

    // ── discord_send_message ────────────────────────────────────────────
    {
      name: 'discord_send_message',
      description:
        'Send a message to a Discord channel, or to a user by passing userId instead of ' +
        'channelId (the DM channel is opened for you). This posts a real message that real ' +
        'people are notified about, so the user confirms before it goes out.',
      category: 'communication',
      safetyLevel: 'confirm',
      confirmPrompt: (p) =>
        p.channelId
          ? `Send Discord message to channel ${String(p.channelId)}: "${truncate(String(p.content ?? ''))}"`
          : `Send Discord direct message to user ${String(p.userId)}: "${truncate(String(p.content ?? ''))}"`,
      inputSchema: {
        type: 'object',
        properties: {
          channelId: { type: 'string', description: 'Target channel id. Mutually exclusive with userId.' },
          userId: { type: 'string', description: 'Target user id for a DM. Mutually exclusive with channelId.' },
          content: {
            type: 'string',
            description: `Message text (max ${MAX_MESSAGE_LENGTH} characters).`,
          },
        },
        required: ['content'],
        additionalProperties: false,
      },
      async execute(params, context: AgentContext) {
        const channelId = typeof params.channelId === 'string' ? params.channelId.trim() : '';
        const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
        if (!channelId && !userId) {
          return fail('Provide either channelId (a channel) or userId (a direct message).');
        }
        const content = requiredString(params.content, 'content');
        if (typeof content !== 'string') return content;

        let targetChannel = channelId;
        if (!targetChannel) {
          // Discord has no "send to user" endpoint — the DM channel must exist
          // first. A failure here must never be reported as a delivered message.
          const dm = await openDirectChannel(userId, { db: context.db });
          if (!dm.ok || !dm.data?.id) {
            if (dm.status === 401) return rejectedCredential();
            if (dm.status === 404) return fail(`No Discord user with id "${userId}".`);
            return fromApi(dm);
          }
          targetChannel = dm.data.id;
        }

        const res = await sendMessage(targetChannel, clampMessage(content), { db: context.db });
        if (!res.ok) {
          if (res.status === 401) return rejectedCredential();
          if (res.status === 403) {
            return fail(
              `Discord refused the message — Henry does not have permission to post in that channel.`,
            );
          }
          if (res.status === 404) {
            return fail(`No Discord channel with id "${targetChannel}". Use discord_list_channels.`);
          }
          return fromApi(res);
        }
        return ok({
          sent: true,
          channelId: targetChannel,
          messageId: res.data?.id ?? null,
          content: res.data?.content ?? clampMessage(content),
        });
      },
    },
  ];
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}