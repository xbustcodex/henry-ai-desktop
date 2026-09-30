/**
 * coverSpecs — pure book-cover math + prompt/spec builders for the Book panel's
 * Cover Studio (build plan: Henry designs covers two ways — teach or do).
 *
 * KDP paperback rules: trim sizes, 0.125" bleed, spine width from page count ×
 * paper thickness, full-wrap dimensions (back + spine + front + bleed) in inches
 * and pixels at 300 DPI, plus the standard ebook cover (1600 × 2560).
 *
 * No DOM, no IPC, no imports — everything here is unit-tested in coverSpecs.test.ts.
 */

// ── Constants ────────────────────────────────────────────────────────────────

export const DPI = 300;
export const BLEED_IN = 0.125;
export const MIN_PAGE_COUNT = 24;

/** KDP's recommended ebook cover: 1600 × 2560 px (1:1.6 ratio). */
export const EBOOK_COVER = { widthPx: 1600, heightPx: 2560 } as const;

/** KDP requires ~79+ pages before the spine is thick enough for spine text. */
export const SPINE_TEXT_MIN_PAGES = 79;

// ── Trim sizes ───────────────────────────────────────────────────────────────

export interface TrimSize {
  id: string;
  label: string;
  widthIn: number;
  heightIn: number;
}

/** Standard KDP paperback trim sizes (US). */
export const TRIM_SIZES: TrimSize[] = [
  { id: '5x8', label: '5″ × 8″', widthIn: 5, heightIn: 8 },
  { id: '5.06x7.81', label: '5.06″ × 7.81″', widthIn: 5.06, heightIn: 7.81 },
  { id: '5.25x8', label: '5.25″ × 8″', widthIn: 5.25, heightIn: 8 },
  { id: '5.5x8.5', label: '5.5″ × 8.5″', widthIn: 5.5, heightIn: 8.5 },
  { id: '6x9', label: '6″ × 9″ (most common)', widthIn: 6, heightIn: 9 },
  { id: '6.14x9.21', label: '6.14″ × 9.21″', widthIn: 6.14, heightIn: 9.21 },
  { id: '7x10', label: '7″ × 10″', widthIn: 7, heightIn: 10 },
  { id: '8.5x11', label: '8.5″ × 11″', widthIn: 8.5, heightIn: 11 },
];

export function getTrimSize(id: string): TrimSize {
  return TRIM_SIZES.find((t) => t.id === id) ?? TRIM_SIZES[4]; // default 6x9
}

// ── Paper types (KDP per-page spine thickness) ──────────────────────────────

export type PaperType = 'white' | 'cream' | 'color';

export interface PaperSpec {
  id: PaperType;
  label: string;
  /** Spine inches added per page (KDP published values). */
  inchesPerPage: number;
  maxPages: number;
}

export const PAPER_TYPES: PaperSpec[] = [
  { id: 'white', label: 'White paper', inchesPerPage: 0.002252, maxPages: 828 },
  { id: 'cream', label: 'Cream paper', inchesPerPage: 0.0025, maxPages: 776 },
  { id: 'color', label: 'Color paper', inchesPerPage: 0.002347, maxPages: 828 },
];

export function getPaperSpec(id: PaperType): PaperSpec {
  return PAPER_TYPES.find((p) => p.id === id) ?? PAPER_TYPES[0];
}

// ── Core math ────────────────────────────────────────────────────────────────

export function inchesToPixels(inches: number, dpi: number = DPI): number {
  return Math.round(inches * dpi);
}

/** Spine width in inches for a page count + paper type. */
export function spineWidthIn(pageCount: number, paper: PaperType): number {
  const pages = Math.max(0, Math.floor(pageCount));
  return pages * getPaperSpec(paper).inchesPerPage;
}

/** KDP only prints spine text when the book is thick enough (~79+ pages). */
export function spineTextAllowed(pageCount: number): boolean {
  return pageCount >= SPINE_TEXT_MIN_PAGES;
}

/** Clamp a raw page-count input into KDP's valid range for the paper type. */
export function clampPageCount(pageCount: number, paper: PaperType): number {
  const max = getPaperSpec(paper).maxPages;
  const n = Math.floor(Number.isFinite(pageCount) ? pageCount : MIN_PAGE_COUNT);
  return Math.min(max, Math.max(MIN_PAGE_COUNT, n));
}

export interface FullWrapSpec {
  trim: TrimSize;
  pageCount: number;
  paper: PaperType;
  bleedIn: number;
  dpi: number;
  spineIn: number;
  /** bleed + back + spine + front + bleed */
  widthIn: number;
  /** trim height + top bleed + bottom bleed */
  heightIn: number;
  widthPx: number;
  heightPx: number;
  spinePx: number;
  bleedPx: number;
  spineTextOk: boolean;
}

/**
 * Full-wrap print cover dimensions (one flat image: back cover + spine + front
 * cover, with bleed on all four outside edges), in inches and 300-DPI pixels.
 */
export function fullWrapSpec(trimId: string, pageCount: number, paper: PaperType): FullWrapSpec {
  const trim = getTrimSize(trimId);
  const pages = clampPageCount(pageCount, paper);
  const spineIn = spineWidthIn(pages, paper);
  const widthIn = BLEED_IN + trim.widthIn + spineIn + trim.widthIn + BLEED_IN;
  const heightIn = trim.heightIn + BLEED_IN * 2;
  return {
    trim,
    pageCount: pages,
    paper,
    bleedIn: BLEED_IN,
    dpi: DPI,
    spineIn,
    widthIn,
    heightIn,
    widthPx: inchesToPixels(widthIn),
    heightPx: inchesToPixels(heightIn),
    spinePx: inchesToPixels(spineIn),
    bleedPx: inchesToPixels(BLEED_IN),
    spineTextOk: spineTextAllowed(pages),
  };
}

/** Front cover only, at trim size × 300 DPI (no bleed — for finishing in Canva). */
export function frontCoverPrintPixels(trimId: string): { widthPx: number; heightPx: number } {
  const trim = getTrimSize(trimId);
  return { widthPx: inchesToPixels(trim.widthIn), heightPx: inchesToPixels(trim.heightIn) };
}

/** Display-friendly inches: up to 3 decimals, trailing zeros trimmed. */
export function formatIn(n: number): string {
  return `${parseFloat(n.toFixed(3))}"`;
}

/** Filesystem-safe slug from a book title. */
export function coverSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'untitled';
}

// ── Genres (drive art prompts, typography, and guide conventions) ───────────

export interface GenreSpec {
  id: string;
  label: string;
  /** Fed to the image model as art direction. */
  artDirection: string;
  /** Typography family the composer + guide should lean on. */
  typography: 'serif' | 'sans';
  /** Plain-English convention notes for the Teach-me guide. */
  conventions: string;
  defaultLayout: 'classic' | 'top-title' | 'bottom-band';
}

export const GENRES: GenreSpec[] = [
  {
    id: 'memoir',
    label: 'Memoir / Life story',
    artDirection:
      'evocative, warm, personal — a single symbolic object, landscape, or silhouette with soft natural light and gentle film grain; intimate and honest, not staged',
    typography: 'serif',
    conventions:
      'Memoir covers favor one quiet, symbolic image and elegant serif type; the author name matters as much as the title.',
    defaultLayout: 'classic',
  },
  {
    id: 'faith',
    label: 'Faith / Christian',
    artDirection:
      'reverent and hopeful — light rays, open sky, ancient paper or subtle dawn landscape textures; warm gold and deep blue tones, dignified and uncluttered',
    typography: 'serif',
    conventions:
      'Christian/faith covers use light as a motif (dawn, rays, open sky), warm-gold-on-deep-blue palettes, and classic serif type that signals trust and tradition.',
    defaultLayout: 'classic',
  },
  {
    id: 'selfhelp',
    label: 'Self-help / Inspiration',
    artDirection:
      'clean, bright, optimistic — bold flat color field or simple uplifting metaphor (sunrise, path, open door) with lots of negative space',
    typography: 'sans',
    conventions:
      'Self-help covers are typography-first: big bold title on a clean bright background, minimal imagery, high contrast.',
    defaultLayout: 'top-title',
  },
  {
    id: 'business',
    label: 'Business',
    artDirection:
      'minimal and confident — abstract geometric shapes or a single strong metaphorical object on a solid or subtly gradient background',
    typography: 'sans',
    conventions:
      'Business covers are minimal: solid color, one graphic device, strong sans-serif title, author credential prominent.',
    defaultLayout: 'top-title',
  },
  {
    id: 'thriller',
    label: 'Thriller / Suspense',
    artDirection:
      'dark, high-contrast, cinematic — moody silhouette, fog, lone figure or ominous landscape; desaturated palette with one accent color',
    typography: 'sans',
    conventions:
      'Thrillers go dark and high-contrast with huge condensed type — often the author name as large as the title.',
    defaultLayout: 'bottom-band',
  },
  {
    id: 'mystery',
    label: 'Mystery / Crime',
    artDirection:
      'atmospheric and shadowy — night scene, rain, a lit window or empty street; muted palette with a single warning accent',
    typography: 'serif',
    conventions:
      'Mystery covers set a scene at night with one intriguing detail; strong type on a scrim keeps it readable.',
    defaultLayout: 'bottom-band',
  },
  {
    id: 'romance',
    label: 'Romance',
    artDirection:
      'warm, soft, emotional — golden-hour light, florals or an intimate scenic moment; blush, coral, and cream palette',
    typography: 'serif',
    conventions:
      'Romance covers are warm and soft with script-flavored or elegant serif titles and golden-hour palettes.',
    defaultLayout: 'classic',
  },
  {
    id: 'fantasy',
    label: 'Fantasy',
    artDirection:
      'epic and painterly — dramatic landscape, castle, mythical creature or glowing artifact; rich jewel tones and volumetric light',
    typography: 'serif',
    conventions:
      'Fantasy covers are painterly and epic with ornate serif titles; a central glowing focal object is a classic move.',
    defaultLayout: 'classic',
  },
  {
    id: 'scifi',
    label: 'Science fiction',
    artDirection:
      'sleek and vast — starfields, planetary horizons, megastructures or neon-lit tech; cool blues, teals and violet with strong geometry',
    typography: 'sans',
    conventions:
      'Sci-fi covers use vast scale, cool palettes, and clean geometric sans-serif type, often letterspaced wide.',
    defaultLayout: 'top-title',
  },
  {
    id: 'literary',
    label: 'Literary fiction',
    artDirection:
      'artful and restrained — abstract texture, painterly detail, or an off-center quiet object; muted sophisticated palette',
    typography: 'serif',
    conventions:
      'Literary covers are understated and art-forward; type is modest, well-set serif with generous spacing.',
    defaultLayout: 'classic',
  },
  {
    id: 'children',
    label: "Children's",
    artDirection:
      'bright, friendly, illustrated — playful characters or scenes in a colorful hand-drawn or storybook illustration style',
    typography: 'sans',
    conventions:
      "Children's covers are bright, illustrated, and playful with big rounded friendly type.",
    defaultLayout: 'top-title',
  },
];

export function getGenre(id: string): GenreSpec {
  return GENRES.find((g) => g.id === id) ?? GENRES[0];
}

// ── The cover brief ──────────────────────────────────────────────────────────

export interface CoverBrief {
  title: string;
  subtitle?: string;
  author: string;
  genreId: string;
  /** Free-form art direction / mood notes from the author. */
  notes?: string;
  trimId: string;
  pageCount: number;
  paper: PaperType;
}

// ── Prompt builders (pure — testable) ───────────────────────────────────────

/**
 * Image-model prompt for the front-cover ART ONLY. Title/author text is
 * overlaid on canvas afterward, so the prompt forbids any text in the image.
 */
export function buildArtPrompt(brief: CoverBrief): string {
  const genre = getGenre(brief.genreId);
  const layoutHint =
    genre.defaultLayout === 'top-title'
      ? 'upper third'
      : genre.defaultLayout === 'bottom-band'
        ? 'lower third'
        : 'upper and lower areas';
  const parts = [
    `Professional book cover background artwork for a ${genre.label.toLowerCase()} book titled "${brief.title}".`,
    `Art direction: ${genre.artDirection}.`,
  ];
  if (brief.notes?.trim()) parts.push(`Author's notes: ${brief.notes.trim()}.`);
  parts.push(
    'Tall portrait composition suited to a book cover.',
    `Keep the ${layoutHint} of the image calm and uncluttered so title text can be placed over it.`,
    'IMPORTANT: absolutely NO text, NO letters, NO words, NO numbers, NO typography of any kind anywhere in the image — the title and author will be added separately.',
  );
  return parts.join(' ');
}

/**
 * Chat prompt for Mode A ("Teach me") — asks Henry for a step-by-step guide
 * with THIS book's exact computed dimensions baked in so the model never
 * invents numbers.
 */
export function buildTeachMePrompt(brief: CoverBrief): string {
  const genre = getGenre(brief.genreId);
  const wrap = fullWrapSpec(brief.trimId, brief.pageCount, brief.paper);
  const front = frontCoverPrintPixels(brief.trimId);
  const paper = getPaperSpec(brief.paper);
  return [
    `Write me a complete, beginner-friendly, step-by-step guide (markdown, with ## section headings) for designing and building the cover for my book myself, using free tools. Be specific and practical — this is a working checklist, not theory.`,
    ``,
    `MY BOOK:`,
    `- Title: ${brief.title}`,
    brief.subtitle ? `- Subtitle: ${brief.subtitle}` : null,
    `- Author: ${brief.author}`,
    `- Genre: ${genre.label}`,
    brief.notes?.trim() ? `- My art direction notes: ${brief.notes.trim()}` : null,
    ``,
    `EXACT DIMENSIONS (already computed for my book — use these numbers verbatim, do not recalculate):`,
    `- Trim size: ${wrap.trim.label} (${formatIn(wrap.trim.widthIn)} × ${formatIn(wrap.trim.heightIn)})`,
    `- Page count: ${wrap.pageCount} on ${paper.label.toLowerCase()}`,
    `- Spine width: ${formatIn(wrap.spineIn)} (${paper.inchesPerPage}"/page × ${wrap.pageCount} pages)${wrap.spineTextOk ? '' : ' — too thin for spine text (KDP needs 79+ pages)'}`,
    `- Bleed: ${formatIn(wrap.bleedIn)} on all outside edges`,
    `- FULL-WRAP print cover (back + spine + front + bleed): ${formatIn(wrap.widthIn)} × ${formatIn(wrap.heightIn)} = ${wrap.widthPx} × ${wrap.heightPx} px at 300 DPI`,
    `- Front cover only at 300 DPI: ${front.widthPx} × ${front.heightPx} px`,
    `- Ebook cover: ${EBOOK_COVER.widthPx} × ${EBOOK_COVER.heightPx} px (JPG or PNG, RGB)`,
    ``,
    `COVER THE FOLLOWING SECTIONS:`,
    `1. Concept — what ${genre.label.toLowerCase()} covers conventionally look like (${genre.conventions}) and 2–3 concrete concept ideas for MY book specifically.`,
    `2. Set up the canvas — exact steps in Canva (free) and GIMP (free) using the pixel dimensions above, for both the ebook cover and the full-wrap print cover.`,
    `3. Artwork — where to get free-to-use art/photos (and rights to check), or how to prompt an AI image generator (remind me: no text baked into the art).`,
    `4. Typography — ${genre.typography}-leaning font pairings (free fonts on Google Fonts), sizes and hierarchy for title/subtitle/author, contrast and readability tricks (scrims, shadows), and thumbnail testing.`,
    `5. Spine and back cover — spine text rules${wrap.spineTextOk ? '' : ' (mine is too thin for spine text — say so and tell me what to do instead)'}, back-cover blurb layout, and leaving the KDP barcode zone (2" × 1.2", bottom-right of back cover) clear.`,
    `6. Export and KDP upload — file formats KDP accepts for print (single-page PDF, full wrap, 300 DPI, flattened) and ebook (JPG/PNG), where each gets uploaded in KDP, and how to use KDP's Print Previewer to check it before publishing.`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

// ── Print-specs text (saved next to exports so wrap can be finished in Canva) ─

export function buildPrintSpecsText(brief: CoverBrief): string {
  const genre = getGenre(brief.genreId);
  const wrap = fullWrapSpec(brief.trimId, brief.pageCount, brief.paper);
  const front = frontCoverPrintPixels(brief.trimId);
  const paper = getPaperSpec(brief.paper);
  return [
    `PRINT COVER SPECS — ${brief.title}`,
    `by ${brief.author} · ${genre.label}`,
    `Generated by Henry Cover Studio on ${new Date().toISOString().slice(0, 10)} (Amazon KDP paperback)`,
    ``,
    `BOOK SETUP`,
    `  Trim size:   ${formatIn(wrap.trim.widthIn)} × ${formatIn(wrap.trim.heightIn)}`,
    `  Page count:  ${wrap.pageCount} pages, ${paper.label.toLowerCase()}`,
    `  Spine width: ${formatIn(wrap.spineIn)}  (${paper.inchesPerPage}"/page × ${wrap.pageCount} pages)`,
    `  Bleed:       ${formatIn(wrap.bleedIn)} on all outside edges`,
    `  Spine text:  ${wrap.spineTextOk ? 'OK — thick enough for spine text' : `NOT allowed — KDP needs ${SPINE_TEXT_MIN_PAGES}+ pages for spine text`}`,
    ``,
    `FULL-WRAP PRINT COVER (one flat image: back + spine + front, with bleed)`,
    `  Width:  ${formatIn(wrap.widthIn)}  = ${formatIn(wrap.bleedIn)} bleed + ${formatIn(wrap.trim.widthIn)} back + ${formatIn(wrap.spineIn)} spine + ${formatIn(wrap.trim.widthIn)} front + ${formatIn(wrap.bleedIn)} bleed`,
    `  Height: ${formatIn(wrap.heightIn)}  = ${formatIn(wrap.trim.heightIn)} trim + ${formatIn(wrap.bleedIn)} top + ${formatIn(wrap.bleedIn)} bottom`,
    `  At 300 DPI: ${wrap.widthPx} × ${wrap.heightPx} px  (spine = ${wrap.spinePx} px, bleed = ${wrap.bleedPx} px)`,
    ``,
    `FILES HENRY EXPORTS`,
    `  Ebook cover:      ${EBOOK_COVER.widthPx} × ${EBOOK_COVER.heightPx} px PNG — upload as-is to KDP ebook.`,
    `  Print front PNG:  ${front.widthPx} × ${front.heightPx} px (front cover at trim size, 300 DPI, no bleed).`,
    ``,
    `FINISH THE FULL WRAP IN CANVA (Henry doesn't build the print PDF)`,
    `  1. Canva → Create a design → Custom size → ${parseFloat(wrap.widthIn.toFixed(3))} × ${parseFloat(wrap.heightIn.toFixed(3))} in.`,
    `  2. Place Henry's print front PNG on the RIGHT panel: its left edge sits ${formatIn(BLEED_IN + wrap.trim.widthIn + wrap.spineIn)} from the canvas's left edge.`,
    `  3. Fill the spine (center strip, ${formatIn(wrap.spineIn)} wide) and the back cover (left panel).`,
    `  4. Keep the KDP barcode zone clear: 2" × 1.2" at the bottom-right of the BACK cover.`,
    `  5. Keep all text at least 0.25" inside the trim edges (safe zone).`,
    `  6. Download as PDF Print (flattened), then upload to KDP paperback → Cover.`,
    `  7. Always run KDP's online Print Previewer before publishing.`,
  ].join('\n');
}
