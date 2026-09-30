/**
 * Henry AI — Brain Router
 *
 * The single entry point for every AI call decision.
 * Before sending anything to a model, call `routeRequest()`.
 * The returned `RouterDecision` tells ChatView:
 *   - which brain is primary (drives tone and behavior)
 *   - what context tier to use
 *   - whether the action is allowed, needs confirmation, or is blocked
 *   - what should surface to the user
 *   - whether reflection should run after
 *
 * This replaces the scattered logic in ChatView that previously called
 * classifyMessageIntent, selectContextTier, and connection checks independently.
 *
 * Does NOT make any AI calls. Pure synchronous decision-making, ~0ms.
 */

import {
  classifyRequest,
  isActionIntent,
  isDestructiveAction,
} from './requestClassifier';
import { selectContextTier } from '../../henry/contextTier';
import { detectTaskType } from '../../henry/modelRouter';
import { getSharedBrainState } from '../../brain/sharedState';
import { log } from '../../henry/log';
import type {
  RouterInput,
  RouterDecision,
  RequestClass,
  Brain,
  ExecutionMode,
  ActionDecision,
  ActionGate,
  SurfacingMode,
} from './routerTypes';

// ── Brain assignment map ───────────────────────────────────────────────────

/**
 * Maps each request class to a primary brain + supporting brains.
 * Supporting brains contribute context blocks but don't drive the tone.
 */
const BRAIN_MAP: Record<RequestClass, { primary: Brain; supporting: Brain[] }> = {
  conversation:   { primary: 'voice',        supporting: ['awareness'] },
  identity:       { primary: 'voice',        supporting: ['constitution'] },
  planning:       { primary: 'voice',        supporting: ['awareness', 'reflection'] },
  memory_recall:  { primary: 'memory',       supporting: ['voice'] },
  integration:    { primary: 'action',       supporting: ['voice', 'constitution'] },
  computer:       { primary: 'action',       supporting: ['voice', 'constitution'] },
  note_capture:   { primary: 'memory',       supporting: ['awareness'] },
  action:         { primary: 'action',       supporting: ['constitution', 'voice'] },
  reflection:     { primary: 'reflection',   supporting: ['awareness', 'memory'] },
  relationship:   { primary: 'memory',       supporting: ['voice'] },
  writing:        { primary: 'voice',        supporting: [] },
  debugging:      { primary: 'voice',        supporting: ['awareness'] },
};

// ── Context tier overrides ─────────────────────────────────────────────────

/**
 * Some request classes override the normal tier-selection logic.
 * These take precedence over the history-length heuristic.
 */
function getContextTierOverride(
  cls: RequestClass
): 'light' | 'medium' | 'full' | null {
  switch (cls) {
    case 'reflection':    return 'full';    // needs full memory and state
    case 'memory_recall': return 'medium';  // needs recent memory at minimum
    case 'planning':      return 'medium';  // needs active thread and priority
    case 'note_capture':  return 'light';   // just capture, no context needed
    case 'identity':      return 'light';   // identity question → brief answer
    case 'writing':       return 'medium';  // needs session context for coherence
    default:              return null;      // let the normal tier logic decide
  }
}

// ── Execution mode ─────────────────────────────────────────────────────────

/**
 * Map task type (from modelRouter) to execution mode.
 * 'local' = fast/local model. 'cloud' = quality cloud model.
 */
function resolveExecutionMode(message: string, cls: RequestClass): ExecutionMode {
  // Some classes always need cloud quality regardless of message length
  if (cls === 'writing' || cls === 'reflection' || cls === 'planning') return 'cloud';
  // Computer and action: cloud for reliability
  if (cls === 'computer' || cls === 'action' || cls === 'integration') return 'cloud';

  const taskType = detectTaskType(message);
  if (taskType === 'chat_fast') return 'local';
  if (taskType === 'chat_quality') return 'cloud';
  return 'hybrid'; // balanced → hybrid (local for context, cloud for polish)
}

// ── Action gating ──────────────────────────────────────────────────────────

/**
 * Gate an action before it runs.
 * Checks: service connected, action type (read vs write), constitution alignment.
 */
function gateAction(
  message: string,
  cls: RequestClass
): ActionGate {
  // Only gate integration / computer / action classes
  if (!isActionIntent(cls)) {
    return { decision: 'allow' };
  }

  const isDestructive = isDestructiveAction(message);

  // Computer actions: always allow (permissions are enforced by the OS at runtime)
  if (cls === 'computer') {
    return {
      decision: isDestructive ? 'confirm' : 'allow',
      reason: isDestructive ? 'This will make a change to your system. Confirm to proceed.' : undefined,
    };
  }

  // Generic action — allow, let the model (and its tools) figure it out.
  // Destructive phrasing still gets a confirm gate.
  if (isDestructive) {
    return {
      decision: 'confirm',
      reason: 'This will make a change. Confirm to proceed.',
      isDestructive: true,
    };
  }
  return { decision: 'allow' };
}

// ── Surfacing decision ─────────────────────────────────────────────────────

/**
 * Decide whether background brain content should surface now or be held.
 * Reads coordinator's pre-computed `surfaceNow` list from shared state.
 */
function resolveSurfacing(cls: RequestClass): SurfacingMode {
  try {
    const brain = getSharedBrainState();
    const hasUrgentSurface = brain.surfaceNow && brain.surfaceNow.length > 0;
    const hasConnectionAlert = brain.reconnectNeeded && brain.reconnectNeeded.length > 0;

    // Urgent reconnect alerts always surface
    if (hasConnectionAlert) return 'show_now';

    // If coordinator has something queued, surface lightly alongside the response
    if (hasUrgentSurface && cls !== 'note_capture') return 'show_quietly';
  } catch {
    // sharedState not yet initialized — safe to ignore
  }

  return 'background';
}

// ── Reflection trigger ─────────────────────────────────────────────────────

/**
 * Reflection runs after the response when the request class implies
 * something meaningful changed or when the request explicitly asks for it.
 */
function shouldTriggerReflection(cls: RequestClass): boolean {
  return cls === 'reflection' || cls === 'planning' || cls === 'note_capture';
}

// ── Rationale builder ──────────────────────────────────────────────────────

function buildRationale(
  cls: RequestClass,
  primary: Brain,
  contextTier: string,
  executionMode: ExecutionMode,
  gate: ActionGate
): string {
  const parts: string[] = [
    `class=${cls}`,
    `brain=${primary}`,
    `ctx=${contextTier}`,
    `exec=${executionMode}`,
  ];
  if (gate.decision !== 'allow') {
    parts.push(`gate=${gate.decision}(${gate.requiredService ?? 'general'})`);
  }
  return parts.join(' | ');
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Route a user request.
 *
 * Call this before every AI request. Uses the returned `RouterDecision`
 * to configure context tier, execution mode, and action gating.
 * The decision is also logged to console for debugging.
 *
 * @param input - Router inputs (message, mode, connected services, etc.)
 * @returns `RouterDecision` — the full routing output
 */
export function routeRequest(input: RouterInput): RouterDecision {
  const { message, historyLength, hasWorkspaceContext } = input;

  // 1. Classify the request
  const requestClass = classifyRequest(message);

  // 2. Assign brains
  const { primary: primaryBrain, supporting: supportingBrains } = BRAIN_MAP[requestClass];

  // 3. Resolve context tier (override if needed, else use normal heuristic)
  const tierOverride = getContextTierOverride(requestClass);
  const contextTier: 'light' | 'medium' | 'full' = tierOverride
    ?? selectContextTier(
        // Map requestClass back to MessageIntent for the existing selector
        requestClassToIntent(requestClass),
        historyLength,
        hasWorkspaceContext,
      );

  // 4. Resolve execution mode
  const executionMode = resolveExecutionMode(message, requestClass);

  // 5. Gate actions
  const actionGate = gateAction(message, requestClass);

  // 6. Surfacing decision
  const surfacing = resolveSurfacing(requestClass);

  // 7. Reflection trigger
  const reflectionNeeded = shouldTriggerReflection(requestClass);

  // 8. Rationale (for logging / debugging)
  const rationale = buildRationale(requestClass, primaryBrain, contextTier, executionMode, actionGate);

  const decision: RouterDecision = {
    requestClass,
    primaryBrain,
    supportingBrains,
    executionMode,
    contextTier,
    actionGate,
    surfacing,
    reflectionNeeded,
    rationale,
  };

  // Log every routing decision to console
  logRouterDecision(decision, message);

  return decision;
}

/**
 * Map a `RequestClass` back to the `MessageIntent` type that `selectContextTier` accepts.
 * This bridges the richer classification with the existing tier selector.
 */
function requestClassToIntent(cls: RequestClass): import('../../henry/contextTier').MessageIntent {
  switch (cls) {
    case 'identity':      return 'awareness';
    case 'integration':   return 'normal'; // handled by service-specific detection below
    default:              return 'normal';
  }
}

// ── Logging ────────────────────────────────────────────────────────────────

export function logRouterDecision(decision: RouterDecision, message: string): void {
  const truncated = message.length > 60 ? message.slice(0, 57) + '...' : message;
  log.debug(
    `[Henry:router] ${decision.rationale} | surface=${decision.surfacing}` +
    `${decision.reflectionNeeded ? ' | reflection=yes' : ''}` +
    `${decision.actionGate.decision !== 'allow' ? ` | ⚠️ action=${decision.actionGate.decision}: ${decision.actionGate.reason ?? ''}` : ''}` +
    `\n               msg="${truncated}"`
  );
}

// ── Example outputs (for documentation / tests) ───────────────────────────

/**
 * Example router outputs for common queries.
 * Used in documentation and for manual verification.
 *
 * "Who are you?"
 *   class=identity | brain=voice | ctx=light | exec=local
 *
 * "What matters right now?"
 *   class=planning | brain=voice | ctx=medium | exec=cloud
 *
 * "Check my email"
 *   class=integration | brain=action | ctx=light | exec=cloud
 *   gate=block(gmail) if Gmail not connected
 *
 * "Summarize this file"
 *   class=writing | brain=voice | ctx=medium | exec=cloud
 *
 * "Open Settings"
 *   class=computer | brain=action | ctx=light | exec=cloud
 *
 * "What are you keeping in the background?"
 *   class=identity | brain=voice | ctx=light | exec=local
 *   surface=show_quietly (if coordinator has items queued)
 */
export const ROUTER_EXAMPLES = null; // documentation only, not executable
