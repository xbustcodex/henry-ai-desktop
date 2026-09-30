/**
 * Henry AI — Brain Router Types
 *
 * The output contract for every routing decision.
 * Every AI call is preceded by a `RouterDecision` that explains:
 *   - what type of request this is
 *   - which brain is primary
 *   - whether execution should be local or cloud
 *   - which context tier to use
 *   - whether an action is gated (needs confirmation / is blocked)
 *   - what should surface to the user
 *   - whether reflection should run after
 */

// ── Request Classification ─────────────────────────────────────────────────

/**
 * What kind of thing the user is asking for.
 * Drives brain assignment, execution mode, and context tier.
 */
export type RequestClass =
  | 'conversation'    // general chat, questions, advice
  | 'identity'        // "who are you", "what can you do", "what are you tracking"
  | 'planning'        // roadmaps, priorities, next steps, strategy
  | 'memory_recall'   // "do you remember", "what did we say about", recall questions
  | 'integration'     // email, calendar, slack, github, notion, stripe, linear
  | 'computer'        // shell, screenshot, keyboard/mouse, app control
  | 'note_capture'    // "remember this", "note that", "add to my list"
  | 'action'          // explicit action: "send", "create", "book", "delete"
  | 'reflection'      // "what have I been working on", drift review, weekly summary
  | 'relationship'    // commitments, follow-ups, people, promises
  | 'writing'         // draft, write, compose, polish
  | 'debugging';      // something wrong, fix this, errors, system problems

// ── Brain Assignment ───────────────────────────────────────────────────────

/**
 * Named brains Henry has. Each request gets a primary + optional supporters.
 *
 * voice       — conversational tone, explanations, final user-facing response
 * action      — tool use, integrations, computer control, workflow execution
 * awareness   — current state, active thread, rhythm, what's happening now
 * reflection  — synthesis, drift detection, suggested next move
 * memory      — recall, retrieval, note routing, commitments, relationships
 * constitution — honesty checks, action gating, capability truth, safety
 */
export type Brain =
  | 'voice'
  | 'action'
  | 'awareness'
  | 'reflection'
  | 'memory'
  | 'constitution';

// ── Execution Mode ─────────────────────────────────────────────────────────

/**
 * local  — use the fast/local model (8B, Ollama, etc.)
 * cloud  — use the quality cloud model (70B, GPT-4o, Claude, etc.)
 * hybrid — split: local for thinking, cloud for final response
 */
export type ExecutionMode = 'local' | 'cloud' | 'hybrid';

// ── Action Gate ────────────────────────────────────────────────────────────

export type ActionDecision =
  | 'allow'    // safe to run immediately (read-only, or clearly requested)
  | 'confirm'  // ask user before executing (write, send, delete)
  | 'block'    // cannot run — service not connected, auth missing, etc.
  | 'defer';   // probably not the right moment; surface as a suggestion instead

export interface ActionGate {
  decision: ActionDecision;
  /** Human-readable reason (shown to user when block/confirm). */
  reason?: string;
  /** Service that would be needed (e.g. 'gmail', 'github'). */
  requiredService?: string;
  /** Whether that service is currently connected. */
  isConnected?: boolean;
  /** Whether the action is destructive (delete, send, overwrite). */
  isDestructive?: boolean;
}

// ── Surfacing Mode ─────────────────────────────────────────────────────────

/**
 * show_now      — put it in the main response immediately
 * show_quietly  — surface in workspace/focus bar, not main chat
 * background    — keep it available but don't push it
 * suppress      — don't show; noise level too high or not relevant
 */
export type SurfacingMode = 'show_now' | 'show_quietly' | 'background' | 'suppress';

// ── Router Decision (output contract) ─────────────────────────────────────

/**
 * The complete routing decision produced before every AI call.
 * Every field should be usable for logging and debugging.
 */
export interface RouterDecision {
  requestClass: RequestClass;
  primaryBrain: Brain;
  supportingBrains: Brain[];
  executionMode: ExecutionMode;
  contextTier: 'light' | 'medium' | 'full';
  actionGate: ActionGate;
  surfacing: SurfacingMode;
  reflectionNeeded: boolean;
  /** One-line explanation of why these decisions were made. */
  rationale: string;
}

// ── Router Input ───────────────────────────────────────────────────────────

export interface RouterInput {
  message: string;
  mode: string;
  historyLength: number;
  hasWorkspaceContext: boolean;
}
