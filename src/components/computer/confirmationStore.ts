/**
 * confirmationStore — the queue behind the shell-confirmation dialog.
 *
 * Module scope rather than React context because the requester and the renderer
 * of the dialog are not the same component: PrinterPanel raises a request while
 * HQPanel's host is the only thing on screen. A context provider would have to
 * wrap both, which means editing the app shell — and the whole point of this
 * store is that any panel can opt in by mounting `<GatedChannelHost />`.
 *
 * ## Why a queue
 *
 * `PrinterPanel.sendGcode` pushes every line of a G-code file one at a time, so
 * a paste can raise several confirmations back to back. A single-slot store
 * would drop all but the last one and leave those promises unresolved forever —
 * a hung printer panel rather than a declined one.
 *
 * ## Why cancellation resolves `false`
 *
 * Every pending request is a promise the caller is awaiting, and the caller
 * only arms an approval grant after that promise resolves `true`. Resolving
 * `false` on teardown means a dialog that goes away can never leave a grant
 * behind — which is the one failure mode that would turn a race condition into
 * a security hole.
 */
import type { GatedDescription } from './gatedChannel';

export interface PendingConfirmation extends GatedDescription {
  id: number;
  /** The channel being approved, for the dialog's own copy and for tests. */
  channel: string;
  resolve: (approved: boolean) => void;
}

const queue: PendingConfirmation[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeToConfirmations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The request currently on screen, if any. */
export function currentConfirmation(): PendingConfirmation | null {
  return queue[0] ?? null;
}

/** How many requests are still unanswered. Used by tests and the dialog. */
export function pendingConfirmationCount(): number {
  return queue.length;
}

let nextId = 0;

/** Raise a request. Resolves `true` only if the user approved THIS one. */
export function enqueueConfirmation(
  request: Omit<PendingConfirmation, 'id' | 'resolve'>,
): Promise<boolean> {
  nextId += 1;
  return new Promise<boolean>((resolve) => {
    queue.push({ ...request, id: nextId, resolve });
    emit();
  });
}

/** Answer the front request. Ignored if it has already been answered. */
export function answerConfirmation(id: number, approved: boolean): void {
  const index = queue.findIndex((item) => item.id === id);
  if (index === -1) return;
  const [item] = queue.splice(index, 1);
  item.resolve(approved);
  emit();
}

/** Reject everything still waiting. Never arms anything. */
export function cancelAll(): void {
  const waiting = queue.splice(0, queue.length);
  for (const item of waiting) item.resolve(false);
  emit();
}

let hostCount = 0;

/**
 * Register a mounted dialog. The returned function must be called on unmount.
 *
 * When the last host goes, nothing is left that could answer a prompt, so the
 * whole queue is rejected. While any host remains, one host unmounting does
 * NOT cancel the queue — otherwise navigating away from one panel would silently
 * decline a request another panel is showing.
 */
export function retainHost(): () => void {
  hostCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    hostCount -= 1;
    if (hostCount <= 0) {
      hostCount = 0;
      cancelAll();
    }
  };
}

/** Reset everything. Test-only; production never needs it. */
export function __resetConfirmationStoreForTest(): void {
  queue.splice(0, queue.length);
  listeners.clear();
  hostCount = 0;
  nextId = 0;
}