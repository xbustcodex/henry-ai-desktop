/**
 * Writer / document generation — typed deliverables (no heavy templating engine).
 */

export interface WriterDocumentType {
  id: string;
  label: string;
  description: string;
  readonly defaultSections: readonly string[];
  /** Short phrase for filenames, e.g. "Vision Brief" */
  filenameLabel: string;
}

export const WRITER_DOCUMENT_TYPES = [
  {
    id: 'vision_brief',
    label: 'Vision brief',
    description: 'North star, audience, and success picture in 1–2 pages.',
    defaultSections: ['Purpose', 'Vision', 'Audience', 'Out of scope', 'Success signals', 'Next steps'],
    filenameLabel: 'Vision Brief',
  },
  {
    id: 'roadmap',
    label: 'Roadmap',
    description: 'Phased plan with milestones, dependencies, and rough sequencing.',
    defaultSections: ['Summary', 'Horizons', 'Milestones', 'Dependencies', 'Risks', 'Open questions'],
    filenameLabel: 'Roadmap',
  },
  {
    id: 'strategy_memo',
    label: 'Strategy memo',
    description: 'Decision-oriented memo: context, options, recommendation, tradeoffs.',
    defaultSections: ['Context', 'Problem', 'Options', 'Recommendation', 'Risks', 'Rollout'],
    filenameLabel: 'Strategy Memo',
  },
  {
    id: 'checklist',
    label: 'Checklist',
    description: 'Actionable checklist with owners or order where relevant.',
    defaultSections: ['Goal', 'Prerequisites', 'Steps', 'Verification', 'Notes'],
    filenameLabel: 'Checklist',
  },
  {
    id: 'study_note',
    label: 'Study note',
    description: 'Structured notes for learning: concepts, definitions, examples, review cues.',
    defaultSections: ['Topic', 'Summary', 'Key ideas', 'Examples', 'Questions', 'References'],
    filenameLabel: 'Study Note',
  },
  {
    id: 'sermon_outline',
    label: 'Sermon outline',
    description: 'Preaching outline with text anchors, moves, and application.',
    defaultSections: ['Text & theme', 'Big idea', 'Outline', 'Application', 'Illustrations (optional)'],
    filenameLabel: 'Sermon Outline',
  },
  {
    id: 'build_handoff',
    label: 'Build handoff',
    description: 'Handoff for builders: requirements, constraints, acceptance, links.',
    defaultSections: ['Goal', 'Requirements', 'Constraints', 'Out of scope', 'Acceptance', 'Links / assets'],
    filenameLabel: 'Build Handoff',
  },
  {
    id: 'general_working_doc',
    label: 'General working doc',
    description: 'Flexible working document with clear headings and tight prose.',
    defaultSections: ['Purpose', 'Background', 'Discussion', 'Decisions', 'Next steps'],
    filenameLabel: 'Working Doc',
  },
] as const satisfies readonly WriterDocumentType[];

export type WriterDocumentTypeId = (typeof WRITER_DOCUMENT_TYPES)[number]['id'];

export const WRITER_DOCUMENT_TYPE_IDS = WRITER_DOCUMENT_TYPES.map((t) => t.id) as WriterDocumentTypeId[];

export const DEFAULT_WRITER_DOCUMENT_TYPE_ID: WriterDocumentTypeId = 'general_working_doc';

export function isWriterDocumentTypeId(value: string): value is WriterDocumentTypeId {
  return (WRITER_DOCUMENT_TYPE_IDS as readonly string[]).includes(value);
}

export function getWriterDocumentType(id: string): WriterDocumentType | undefined {
  return WRITER_DOCUMENT_TYPES.find((t) => t.id === id);
}
