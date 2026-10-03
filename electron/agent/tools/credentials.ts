/**
 * Credential tools — Henry's safe view of the secrets the agent can USE.
 *
 * Parity row 4.19 said the agent credential surface "was not exercised". The
 * store itself lives in `electron/agent/credentials.ts`; this kit is what
 * exercises it, and it is deliberately the narrowest possible surface:
 * `credential_status` answers "is this connected, and is it encrypted at
 * rest?" and nothing else.
 *
 * There is intentionally NO tool that writes a credential or returns one.
 * A write tool would take the secret through the model and the chat
 * transcript — the exact place a key must never be — and a read tool would
 * put it in a tool payload the renderer sees. Secrets enter and leave the main
 * process through the OS keychain via the Settings surface and
 * `setCredential`/`getCredential`, which no model can reach.
 *
 * Safety tier:
 *   - credential_status  silent — a pure read of metadata the user themselves
 *     configured. It returns booleans and scope names only; there is no
 *     destructive or outbound action to interrupt.
 *
 * Every payload here is assembled from `credentialStatus`, whose return type
 * cannot carry a value, so there is no code path from a stored secret into a
 * tool result.
 */

import type { ToolDefinition, ToolResult } from "../types";
import {
  credentialStatus,
  listCredentialScopes,
  validateScope,
} from "../credentials";

function ok(data: unknown): ToolResult {
  return { ok: true, data };
}

function fail(error: string, retryable = false): ToolResult {
  return { ok: false, error, retryable };
}

export function credentialTools(): ToolDefinition[] {
  return [
    // ── credential_status ────────────────────────────────────────────────
    {
      name: "credential_status",
      description:
        "Report which service credentials the user has configured, and " +
        "whether each one is encrypted at rest. Call this before promising " +
        "to do something that needs a connected account (push to GitHub, " +
        "file to QuickBooks) so you can tell the user what to set up instead " +
        "of guessing. Returns configuration state ONLY — never a token, key " +
        "or fragment of one.",
      category: "system",
      safetyLevel: "silent",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description:
              "A single credential scope, e.g. 'github'. Omit to list every " +
              "scope that has a credential stored.",
          },
        },
        additionalProperties: false,
      },
      async execute(params, { db }) {
        try {
          const raw = params.scope;
          if (raw !== undefined && raw !== "") {
            const check = validateScope(raw);
            if (!check.ok) return fail(check.error);
            const status = credentialStatus(db, check.scope);
            return ok({
              credentials: [status],
              count: 1,
              plaintext_scopes: status.encrypted_at_rest ? [] : [status.scope],
            });
          }

          const credentials = listCredentialScopes(db).map((scope) =>
            credentialStatus(db, scope),
          );
          return ok({
            credentials,
            count: credentials.length,
            // Names only — a scope whose row is NOT in enc:v1: form is a
            // secret sitting in plaintext on disk, and the user should be told
            // which ones rather than told everything is fine.
            plaintext_scopes: credentials
              .filter((c) => c.configured && !c.encrypted_at_rest)
              .map((c) => c.scope),
            hint:
              credentials.length === 0
                ? "No service credentials are stored yet."
                : undefined,
          });
        } catch (e) {
          return fail(e instanceof Error ? e.message : String(e));
        }
      },
    },
  ];
}
