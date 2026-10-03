/**
 * routineTriggerEvents — the catalogue of events an event-triggered Routine
 * can actually watch.
 *
 * This module lives in `src/` on purpose: the main process imports it to
 * name the events it emits (electron/ipc/taskBroker.ts, electron/knowledge),
 * and the renderer imports it to build the trigger picker in
 * `src/components/routines/RoutinesPanel.tsx`. One list, two sides — so the
 * picker can never offer an event that nothing emits, which is exactly the
 * dead end that let the event trigger ship with no emitter in the first place.
 *
 * A Routine watching an event that never fires holds no timer and costs one
 * map entry, so an unlisted name is inert rather than broken. That is why the
 * picker is a closed list rather than free text: an unlisted name cannot be
 * typed, and therefore cannot be chosen by accident.
 *
 * Names are namespaced dotted identifiers because `parseTrigger` rejects
 * anything else (`EVENT_NAME_RE` in electron/agent/triggers.ts).
 */

export interface RoutineTriggerEvent {
  /** The exact string the bus emits. Must match `EVENT_NAME_RE`. */
  readonly name: string;
  /** Short label for the picker. */
  readonly label: string;
  /** One line explaining when it fires, in the user's terms. */
  readonly description: string;
}

/**
 * Every event the app emits. Adding a name here without wiring an emitter is
 * a lie the UI will tell; wiring an emitter without adding the name here means
 * the Routine that watches it can only be created by hand-editing the DB.
 */
export const ROUTINE_TRIGGER_EVENTS: readonly RoutineTriggerEvent[] = [
  {
    name: 'task.completed',
    label: 'A task finishes',
    description:
      'A queued worker task reaches the end of its run — a long job Henry was carrying out finishes.',
  },
  {
    name: 'knowledge.ingested',
    label: 'Something is added to the knowledge base',
    description:
      'A note, file, or web page is added to the knowledge base. Re-adding identical content does not fire it.',
  },
];

/** The names, for validation and for tests that assert emitter/picker parity. */
export const ROUTINE_TRIGGER_EVENT_NAMES: readonly string[] = ROUTINE_TRIGGER_EVENTS.map((e) => e.name);
