/**
 * Quoting Panel — generate, send, track, and convert maker / freelance quotes.
 *
 * Backed by SQLite (electron/ipc/quoting.ts). Henry can answer pipeline
 * questions ("how much is in my quote pipeline?", "what's my conversion
 * rate?") directly from the same table — zero AI tokens.
 *
 * Layout: left = quote list (filterable by status), right = detail editor
 * with line items, totals, and status workflow. The line-item editor mirrors
 * ProductionRunsPanel's pattern so it feels consistent.
 *
 * "Convert to run" creates a queued production_run row pre-filled with this
 * quote's materials/labor — so an accepted quote becomes a job in one click.
 */
import { safeCopyToClipboard } from '../../utils/clipboardSafe';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { toast, confirmDialog } from '../ui/Toast';

// ── Types ─────────────────────────────────────────────────────────────────

type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';

type LineItemKind =
  | 'material'
  | 'labor'
  | 'machine_time'
  | 'setup'
  | 'markup'
  | 'discount'
  | 'shipping'
  | 'other';

interface LineItem {
  id?: string;
  quote_id?: string;
  kind: LineItemKind;
  description: string;
  quantity: number;
  unit: string;
  unit_cost: number;
  line_total?: number | null;
  taxable: 0 | 1 | boolean;
  machine_id?: string | null;
  material_id?: string | null;
  sort_order?: number;
}

interface QuoteListItem {
  id: string;
  quote_number?: string;
  project_title: string;
  customer_name?: string;
  customer_company?: string;
  status: QuoteStatus;
  total: number;
  currency?: string;
  valid_until?: string;
  sent_at?: string;
  created_at: string;
  updated_at: string;
}

interface Quote extends QuoteListItem {
  customer_id?: string;
  customer_email?: string;
  customer_phone?: string;
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  valid_days?: number;
  terms?: string;
  notes?: string;
  decided_at?: string;
  converted_run_id?: string;
  line_items: LineItem[];
}

interface Machine {
  id: string;
  name: string;
  machine_type: string;
  hourly_rate?: number;
}

interface Material {
  id: string;
  name: string;
  category: string;
  unit: string;
  quantity_unit_cost?: number;
  color?: string;
}

interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
}

interface Summary {
  sinceDays: number;
  byStatus: Record<QuoteStatus, { count: number; value: number }>;
  pipelineValue: number;
  wonValue: number;
  conversionRate: number;
}

// ── API surface (preload-exposed) ─────────────────────────────────────────

interface QuotingAPI {
  quoteList: (opts?: { status?: string; query?: string; limit?: number }) => Promise<QuoteListItem[]>;
  quoteGet: (id: string) => Promise<Quote | null>;
  quoteSave: (q: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;
  quoteDelete: (id: string) => Promise<{ ok: boolean }>;
  quoteSetStatus: (id: string, status: string) => Promise<{ ok: boolean }>;
  quoteDuplicate: (id: string) => Promise<{ ok: boolean; id?: string }>;
  quoteLineItemSave: (item: Record<string, unknown>) => Promise<{ ok: boolean; id?: string }>;
  quoteLineItemDelete: (id: string) => Promise<{ ok: boolean }>;
  quoteLineItemsReorder: (quoteId: string, ids: string[]) => Promise<{ ok: boolean }>;
  quoteSummary: (opts?: { sinceDays?: number }) => Promise<Summary | null>;
  quoteConvertToRun: (quoteId: string, machineId?: string) => Promise<{ ok: boolean; runId?: string }>;
  quoteExportMarkdown: (quoteId: string) => Promise<string | null>;
  makerMachinesList: () => Promise<Machine[]>;
  makerMaterialsList: () => Promise<Material[]>;
  contactsList: (q?: string) => Promise<Contact[]>;
}

function api(): QuotingAPI | null {
  return ((window as unknown) as { henryAPI?: QuotingAPI }).henryAPI ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const inputCls =
  'w-full bg-henry-surface border border-henry-border/30 rounded-xl px-3 py-2 text-sm text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50 transition-all';

const smallInputCls =
  'bg-henry-surface border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text outline-none focus:border-henry-accent/50';

function fmtMoney(n: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n || 0);
  } catch {
    return `$${(n || 0).toFixed(2)}`;
  }
}

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function statusColor(s: QuoteStatus): string {
  switch (s) {
    case 'draft':    return 'bg-henry-text-muted/15 text-henry-text-muted';
    case 'sent':     return 'bg-blue-500/15 text-blue-400';
    case 'accepted': return 'bg-emerald-500/15 text-emerald-400';
    case 'declined': return 'bg-red-500/15 text-red-400';
    case 'expired':  return 'bg-orange-500/15 text-orange-400';
  }
}

const KIND_LABELS: Record<LineItemKind, string> = {
  material: 'Material',
  labor: 'Labor',
  machine_time: 'Machine time',
  setup: 'Setup fee',
  markup: 'Markup',
  discount: 'Discount',
  shipping: 'Shipping',
  other: 'Other',
};

function blankLineItem(quoteId?: string, sortOrder = 0): LineItem {
  return {
    quote_id: quoteId,
    kind: 'material',
    description: '',
    quantity: 1,
    unit: 'ea',
    unit_cost: 0,
    line_total: null,
    taxable: 1,
    sort_order: sortOrder,
  };
}

function lineTotal(it: LineItem): number {
  if (it.line_total !== null && it.line_total !== undefined && it.line_total !== ('' as unknown as number)) {
    return Number(it.line_total) || 0;
  }
  return (Number(it.quantity) || 0) * (Number(it.unit_cost) || 0);
}

function statusOrder(s: QuoteStatus): number {
  const order = { draft: 0, sent: 1, accepted: 2, declined: 3, expired: 4 };
  return order[s] ?? 99;
}

// ── Component ─────────────────────────────────────────────────────────────

export default function QuotingPanel() {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [filter, setFilter] = useState<'all' | QuoteStatus>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [active, setActive] = useState<Quote | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [saving, setSaving] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);

  const reloadList = useCallback(async () => {
    const a = api();
    if (!a) return;
    const opts: { status?: string; query?: string } = {};
    if (filter !== 'all') opts.status = filter;
    if (query.trim()) opts.query = query.trim();
    const list = await a.quoteList(opts).catch(() => [] as QuoteListItem[]);
    setQuotes(Array.isArray(list) ? list : []);
  }, [filter, query]);

  const reloadSummary = useCallback(async () => {
    const a = api();
    if (!a) return;
    const s = await a.quoteSummary({ sinceDays: 90 }).catch(() => null);
    setSummary(s);
  }, []);

  const reloadActive = useCallback(async (id: string | null) => {
    if (!id) {
      setActive(null);
      return;
    }
    const a = api();
    if (!a) return;
    const q = await a.quoteGet(id).catch(() => null);
    setActive(q);
  }, []);

  // Initial load + lookups for dropdowns
  useEffect(() => {
    void reloadList();
    void reloadSummary();
    const a = api();
    if (!a) return;
    a.makerMachinesList().then((m) => setMachines(Array.isArray(m) ? m : [])).catch(() => {});
    a.makerMaterialsList().then((m) => setMaterials(Array.isArray(m) ? m : [])).catch(() => {});
    a.contactsList().then((c) => setContacts(Array.isArray(c) ? c : [])).catch(() => {});
  }, [reloadList, reloadSummary]);

  // Re-load when filter/query change
  useEffect(() => {
    void reloadList();
  }, [filter, query, reloadList]);

  // Load active quote whenever selection changes
  useEffect(() => {
    void reloadActive(selectedId);
  }, [selectedId, reloadActive]);

  // ── Quote actions ───────────────────────────────────────────────────────

  const createQuote = async () => {
    const a = api();
    if (!a) return;
    setSaving(true);
    const r = await a.quoteSave({
      project_title: 'Untitled quote',
      status: 'draft',
      tax_rate: 0,
      currency: 'USD',
      valid_days: 30,
    });
    setSaving(false);
    if (r.ok && r.id) {
      await reloadList();
      await reloadSummary();
      setSelectedId(r.id);
    }
  };

  const saveQuote = async (patch: Partial<Quote>) => {
    if (!active) return;
    const a = api();
    if (!a) return;
    setSaving(true);
    const merged = { ...active, ...patch, id: active.id };
    const r = await a.quoteSave(merged as unknown as Record<string, unknown>);
    setSaving(false);
    if (r.ok) {
      await reloadActive(active.id);
      await reloadList();
      await reloadSummary();
    }
  };

  const setStatus = async (status: QuoteStatus) => {
    if (!active) return;
    const a = api();
    if (!a) return;
    await a.quoteSetStatus(active.id, status);
    await reloadActive(active.id);
    await reloadList();
    await reloadSummary();
  };

  const duplicateQuote = async () => {
    if (!active) return;
    const a = api();
    if (!a) return;
    const r = await a.quoteDuplicate(active.id);
    if (r.ok && r.id) {
      await reloadList();
      setSelectedId(r.id);
    }
  };

  const deleteQuote = async () => {
    if (!active) return;
    if (!(await confirmDialog(`Delete quote "${active.project_title}"? This cannot be undone.`, { destructive: true, confirmLabel: 'Delete' }))) return;
    const a = api();
    if (!a) return;
    await a.quoteDelete(active.id);
    setSelectedId(null);
    await reloadList();
    await reloadSummary();
  };

  // ── Line item actions ──────────────────────────────────────────────────

  const addLineItem = async (kind: LineItemKind = 'material') => {
    if (!active) return;
    const a = api();
    if (!a) return;
    const sortOrder = active.line_items.length;
    const item = { ...blankLineItem(active.id, sortOrder), kind };
    await a.quoteLineItemSave({ ...item, quote_id: active.id });
    await reloadActive(active.id);
    await reloadList();
  };

  const updateLineItem = async (item: LineItem) => {
    const a = api();
    if (!a) return;
    await a.quoteLineItemSave({ ...item, quote_id: active?.id });
    await reloadActive(active?.id || null);
    await reloadList();
  };

  const deleteLineItem = async (id: string) => {
    const a = api();
    if (!a) return;
    await a.quoteLineItemDelete(id);
    await reloadActive(active?.id || null);
    await reloadList();
  };

  // ── Customer picker ────────────────────────────────────────────────────

  const pickCustomer = (c: Contact) => {
    setShowCustomerPicker(false);
    void saveQuote({
      customer_id: c.id,
      customer_name: c.name,
      customer_email: c.email || '',
      customer_phone: c.phone || '',
      customer_company: c.company || '',
    });
  };

  // ── Export / convert ───────────────────────────────────────────────────

  const exportMarkdown = async () => {
    if (!active) return;
    const a = api();
    if (!a) return;
    const md = await a.quoteExportMarkdown(active.id);
    setExportText(md ?? '');
  };

  const copyExport = async () => {
    if (exportText == null) return;
    try {
      await safeCopyToClipboard(exportText);
    } catch {
      /* ignore */
    }
  };

  const convertToRun = async (machineId?: string) => {
    if (!active) return;
    const a = api();
    if (!a) return;
    const r = await a.quoteConvertToRun(active.id, machineId);
    setConvertOpen(false);
    if (r.ok) {
      await reloadActive(active.id);
      await reloadList();
      await reloadSummary();
      toast.success('Created production run. View it in the Runs panel.');
    }
  };

  // ── Derived ────────────────────────────────────────────────────────────

  const sortedQuotes = useMemo(() => {
    return [...quotes].sort((a, b) => {
      const so = statusOrder(a.status) - statusOrder(b.status);
      if (so !== 0) return so;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [quotes]);

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex bg-henry-bg text-henry-text overflow-hidden">
      {/* Left list */}
      <div className="w-80 border-r border-henry-border/20 flex flex-col">
        <div className="p-4 border-b border-henry-border/20">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold tracking-tight">Quotes</h2>
            <button
              onClick={createQuote}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-lg bg-henry-accent text-white font-semibold hover:bg-henry-accent/85 disabled:opacity-50 transition-all"
            >
              + New
            </button>
          </div>
          <input
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={inputCls}
          />
          <div className="flex gap-1 mt-2 flex-wrap">
            {(['all', 'draft', 'sent', 'accepted', 'declined', 'expired'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded-md transition-all ${
                  filter === f
                    ? 'bg-henry-accent/15 text-henry-accent border border-henry-accent/40'
                    : 'border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Summary strip */}
        {summary && (
          <div className="px-4 py-3 border-b border-henry-border/20 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Pipeline</p>
              <p className="text-sm font-bold text-henry-text">{fmtMoney(summary.pipelineValue)}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Won 90d</p>
              <p className="text-sm font-bold text-emerald-400">{fmtMoney(summary.wonValue)}</p>
            </div>
            <div>
              <p className="text-[9px] uppercase tracking-wider text-henry-text-muted">Convert</p>
              <p className="text-sm font-bold text-henry-text">{summary.conversionRate}%</p>
            </div>
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {sortedQuotes.length === 0 ? (
            <div className="p-6 text-center text-xs text-henry-text-muted">
              No quotes yet. Click <span className="text-henry-accent">+ New</span> to start one.
            </div>
          ) : (
            sortedQuotes.map((q) => (
              <button
                key={q.id}
                onClick={() => setSelectedId(q.id)}
                className={`w-full text-left px-4 py-3 border-b border-henry-border/10 hover:bg-henry-surface/50 transition-all ${
                  selectedId === q.id ? 'bg-henry-surface' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-henry-text-muted truncate">
                      {q.quote_number || '—'}
                    </p>
                    <p className="text-sm font-semibold text-henry-text truncate">
                      {q.project_title}
                    </p>
                    <p className="text-[11px] text-henry-text-muted truncate">
                      {q.customer_name || q.customer_company || 'No customer'}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${statusColor(q.status)}`}>
                      {q.status}
                    </span>
                    <p className="text-xs font-bold text-henry-text mt-1">{fmtMoney(q.total, q.currency || 'USD')}</p>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Right detail */}
      <div className="flex-1 overflow-y-auto">
        {!active ? (
          <div className="h-full flex items-center justify-center text-center px-8">
            <div className="max-w-md">
              <div className="text-5xl mb-3 opacity-50">✎</div>
              <h3 className="text-lg font-bold text-henry-text mb-2">Quote builder</h3>
              <p className="text-sm text-henry-text-muted mb-4">
                Build professional quotes with line items pulled from your maker stack — machines,
                materials, labor — then convert accepted quotes into production runs in one click.
              </p>
              <button
                onClick={createQuote}
                className="text-sm px-4 py-2 rounded-lg bg-henry-accent text-white font-semibold hover:bg-henry-accent/85 transition-all"
              >
                + Create your first quote
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto p-6 space-y-6">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-mono text-henry-text-muted mb-1">
                  {active.quote_number || '—'}
                </p>
                <input
                  value={active.project_title}
                  onChange={(e) => setActive({ ...active, project_title: e.target.value })}
                  onBlur={() => saveQuote({ project_title: active.project_title })}
                  placeholder="Project title"
                  className="text-2xl font-bold text-henry-text bg-transparent outline-none w-full"
                />
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded ${statusColor(active.status)}`}>
                    {active.status}
                  </span>
                  <span className="text-xs text-henry-text-muted">
                    Updated {fmtDate(active.updated_at)}
                  </span>
                  {active.valid_until && (
                    <span className="text-xs text-henry-text-muted">
                      · valid until {fmtDate(active.valid_until)}
                    </span>
                  )}
                  {active.converted_run_id && (
                    <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-emerald-500/15 text-emerald-400">
                      → run created
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={duplicateQuote}
                  title="Duplicate"
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-henry-border/30 text-henry-text-muted hover:text-henry-text transition-all"
                >
                  ⎘
                </button>
                <button
                  onClick={deleteQuote}
                  title="Delete"
                  className="text-xs px-2.5 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-all"
                >
                  ⌫
                </button>
              </div>
            </div>

            {/* Status workflow */}
            <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-3">
              <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">
                Status
              </p>
              <div className="flex gap-1.5 flex-wrap">
                {(['draft', 'sent', 'accepted', 'declined', 'expired'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatus(s)}
                    disabled={active.status === s}
                    className={`text-xs px-3 py-1.5 rounded-lg font-semibold transition-all ${
                      active.status === s
                        ? statusColor(s) + ' cursor-default'
                        : 'border border-henry-border/30 text-henry-text-muted hover:text-henry-text'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Customer */}
            <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted">Customer</p>
                <button
                  onClick={() => setShowCustomerPicker((v) => !v)}
                  className="text-xs text-henry-accent hover:underline"
                >
                  {showCustomerPicker ? 'Cancel' : 'Pick from contacts →'}
                </button>
              </div>
              {showCustomerPicker && (
                <div className="bg-henry-bg/50 border border-henry-border/20 rounded-lg p-2 max-h-48 overflow-y-auto">
                  {contacts.length === 0 ? (
                    <p className="text-xs text-henry-text-muted text-center py-3">No contacts yet</p>
                  ) : (
                    contacts.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => pickCustomer(c)}
                        className="w-full text-left px-2 py-1.5 rounded hover:bg-henry-surface/70 text-sm"
                      >
                        <span className="text-henry-text font-medium">{c.name}</span>
                        {c.company && (
                          <span className="text-henry-text-muted text-xs"> · {c.company}</span>
                        )}
                      </button>
                    ))
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <input
                  value={active.customer_name || ''}
                  onChange={(e) => setActive({ ...active, customer_name: e.target.value })}
                  onBlur={() => saveQuote({ customer_name: active.customer_name })}
                  placeholder="Name"
                  className={inputCls}
                />
                <input
                  value={active.customer_company || ''}
                  onChange={(e) => setActive({ ...active, customer_company: e.target.value })}
                  onBlur={() => saveQuote({ customer_company: active.customer_company })}
                  placeholder="Company"
                  className={inputCls}
                />
                <input
                  value={active.customer_email || ''}
                  onChange={(e) => setActive({ ...active, customer_email: e.target.value })}
                  onBlur={() => saveQuote({ customer_email: active.customer_email })}
                  placeholder="email@example.com"
                  type="email"
                  className={inputCls}
                />
                <input
                  value={active.customer_phone || ''}
                  onChange={(e) => setActive({ ...active, customer_phone: e.target.value })}
                  onBlur={() => saveQuote({ customer_phone: active.customer_phone })}
                  placeholder="Phone"
                  className={inputCls}
                />
              </div>
            </div>

            {/* Line items */}
            <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted">
                  Line items ({active.line_items.length})
                </p>
                <div className="flex gap-1.5 flex-wrap">
                  {(['material', 'labor', 'machine_time', 'setup', 'discount'] as LineItemKind[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => addLineItem(k)}
                      className="text-[11px] px-2 py-1 rounded-md border border-henry-border/30 text-henry-text-muted hover:text-henry-text hover:border-henry-accent/50 transition-all"
                    >
                      + {KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
              </div>

              {active.line_items.length === 0 ? (
                <p className="text-xs text-henry-text-muted text-center py-6">
                  No line items yet. Add a material, labor, or setup fee above.
                </p>
              ) : (
                <div className="space-y-2">
                  {active.line_items.map((it, idx) => (
                    <LineItemRow
                      key={it.id || idx}
                      item={it}
                      machines={machines}
                      materials={materials}
                      onChange={(patch) => {
                        const updated = { ...it, ...patch };
                        setActive({
                          ...active,
                          line_items: active.line_items.map((x, i) => (i === idx ? updated : x)),
                        });
                      }}
                      onCommit={(patch) => updateLineItem({ ...it, ...patch })}
                      onDelete={() => it.id && deleteLineItem(it.id)}
                    />
                  ))}
                </div>
              )}

              {/* Totals */}
              <div className="mt-4 pt-4 border-t border-henry-border/20 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-henry-text-muted">Subtotal</span>
                  <span className="text-henry-text font-mono">
                    {fmtMoney(active.subtotal || 0, active.currency || 'USD')}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-henry-text-muted">Tax</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={active.tax_rate || 0}
                      onChange={(e) => setActive({ ...active, tax_rate: parseFloat(e.target.value) || 0 })}
                      onBlur={() => saveQuote({ tax_rate: active.tax_rate })}
                      className={`${smallInputCls} w-16 text-right`}
                    />
                    <span className="text-henry-text-muted">%</span>
                  </div>
                  <span className="text-henry-text font-mono">
                    {fmtMoney(active.tax_amount || 0, active.currency || 'USD')}
                  </span>
                </div>
                <div className="flex items-center justify-between text-base pt-2 border-t border-henry-border/10">
                  <span className="text-henry-text font-bold">Total</span>
                  <span className="text-henry-accent font-bold font-mono text-lg">
                    {fmtMoney(active.total || 0, active.currency || 'USD')}
                  </span>
                </div>
              </div>
            </div>

            {/* Validity + terms + notes */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-4">
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">
                  Validity
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={active.valid_days || 30}
                    onChange={(e) => setActive({ ...active, valid_days: parseInt(e.target.value, 10) || 30 })}
                    onBlur={() => saveQuote({ valid_days: active.valid_days })}
                    className={`${smallInputCls} w-20`}
                  />
                  <span className="text-xs text-henry-text-muted">days from issue</span>
                </div>
                {active.valid_until && (
                  <p className="text-[11px] text-henry-text-muted mt-2">
                    Expires {fmtDate(active.valid_until)}
                  </p>
                )}
              </div>
              <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-4">
                <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">
                  Currency
                </p>
                <select
                  value={active.currency || 'USD'}
                  onChange={(e) => saveQuote({ currency: e.target.value })}
                  className={inputCls}
                >
                  <option value="USD">USD — US dollar</option>
                  <option value="EUR">EUR — Euro</option>
                  <option value="GBP">GBP — British pound</option>
                  <option value="CAD">CAD — Canadian dollar</option>
                  <option value="AUD">AUD — Australian dollar</option>
                </select>
              </div>
            </div>

            <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-4">
              <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">Terms</p>
              <textarea
                rows={3}
                value={active.terms || ''}
                onChange={(e) => setActive({ ...active, terms: e.target.value })}
                onBlur={() => saveQuote({ terms: active.terms })}
                placeholder="50% deposit due to start. Balance due on delivery. Quote valid for 30 days."
                className={inputCls}
              />
            </div>

            <div className="bg-henry-surface/40 border border-henry-border/20 rounded-xl p-4">
              <p className="text-[10px] uppercase tracking-wider text-henry-text-muted mb-2">
                Internal notes
              </p>
              <textarea
                rows={2}
                value={active.notes || ''}
                onChange={(e) => setActive({ ...active, notes: e.target.value })}
                onBlur={() => saveQuote({ notes: active.notes })}
                placeholder="Reminder to self — not shown to customer."
                className={inputCls}
              />
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 sticky bottom-0 bg-henry-bg/95 backdrop-blur py-3 border-t border-henry-border/20 -mx-6 px-6">
              <button
                onClick={exportMarkdown}
                className="text-sm px-4 py-2 rounded-lg bg-henry-surface border border-henry-border/30 text-henry-text hover:border-henry-accent/50 transition-all"
              >
                ↗ Export markdown
              </button>
              {active.status !== 'sent' && active.status !== 'accepted' && (
                <button
                  onClick={() => setStatus('sent')}
                  className="text-sm px-4 py-2 rounded-lg bg-blue-500/15 text-blue-400 border border-blue-500/30 hover:bg-blue-500/25 transition-all"
                >
                  ✉ Mark as sent
                </button>
              )}
              {active.status === 'sent' && (
                <>
                  <button
                    onClick={() => setStatus('accepted')}
                    className="text-sm px-4 py-2 rounded-lg bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25 transition-all"
                  >
                    ✓ Accepted
                  </button>
                  <button
                    onClick={() => setStatus('declined')}
                    className="text-sm px-4 py-2 rounded-lg bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 transition-all"
                  >
                    ✗ Declined
                  </button>
                </>
              )}
              {active.status === 'accepted' && !active.converted_run_id && (
                <button
                  onClick={() => setConvertOpen(true)}
                  className="text-sm px-4 py-2 rounded-lg bg-henry-accent text-white font-semibold hover:bg-henry-accent/85 transition-all"
                >
                  → Convert to production run
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Convert modal */}
      {convertOpen && active && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setConvertOpen(false)}
        >
          <div
            className="bg-henry-surface border border-henry-border/30 rounded-2xl p-6 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-henry-text mb-2">Convert to production run</h3>
            <p className="text-xs text-henry-text-muted mb-4">
              Pick the machine that will do this work. The run will be created in <span className="text-henry-text">queued</span> status with materials and labor pre-filled from this quote.
            </p>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              <button
                onClick={() => convertToRun()}
                className="w-full text-left px-3 py-2 rounded-lg border border-henry-border/30 hover:border-henry-accent/50 transition-all"
              >
                <p className="text-sm font-semibold text-henry-text">No machine</p>
                <p className="text-[11px] text-henry-text-muted">Manual / freelance work</p>
              </button>
              {machines.map((m) => (
                <button
                  key={m.id}
                  onClick={() => convertToRun(m.id)}
                  className="w-full text-left px-3 py-2 rounded-lg border border-henry-border/30 hover:border-henry-accent/50 transition-all"
                >
                  <p className="text-sm font-semibold text-henry-text">{m.name}</p>
                  <p className="text-[11px] text-henry-text-muted">
                    {m.machine_type}
                    {m.hourly_rate ? ` · ${fmtMoney(m.hourly_rate)}/hr` : ''}
                  </p>
                </button>
              ))}
            </div>
            <button
              onClick={() => setConvertOpen(false)}
              className="mt-4 text-xs text-henry-text-muted hover:text-henry-text"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Export modal */}
      {exportText !== null && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setExportText(null)}
        >
          <div
            className="bg-henry-surface border border-henry-border/30 rounded-2xl p-6 max-w-2xl w-full max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-henry-text">Quote markdown</h3>
              <div className="flex gap-2">
                <button
                  onClick={copyExport}
                  className="text-xs px-3 py-1.5 rounded-lg bg-henry-accent text-white font-semibold hover:bg-henry-accent/85 transition-all"
                >
                  Copy
                </button>
                <button
                  onClick={() => setExportText(null)}
                  className="text-xs px-3 py-1.5 rounded-lg border border-henry-border/30 text-henry-text-muted hover:text-henry-text"
                >
                  Close
                </button>
              </div>
            </div>
            <textarea
              readOnly
              value={exportText}
              className="flex-1 bg-henry-bg/40 border border-henry-border/20 rounded-lg p-3 font-mono text-xs text-henry-text outline-none resize-none"
            />
            <p className="text-[10px] text-henry-text-muted mt-2">
              Paste into email, a doc, or your invoicing tool.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Line item row ───────────────────────────────────────────────────────────

interface LineItemRowProps {
  item: LineItem;
  machines: Machine[];
  materials: Material[];
  onChange: (patch: Partial<LineItem>) => void;
  onCommit: (patch: Partial<LineItem>) => void;
  onDelete: () => void;
}

function LineItemRow({ item, machines, materials, onChange, onCommit, onDelete }: LineItemRowProps) {
  const showMachineDropdown = item.kind === 'machine_time';
  const showMaterialDropdown = item.kind === 'material';

  const handleMaterialPick = (matId: string) => {
    const mat = materials.find((m) => m.id === matId);
    if (!mat) {
      onCommit({ material_id: null });
      return;
    }
    const patch: Partial<LineItem> = {
      material_id: mat.id,
      description: mat.name + (mat.color ? ` · ${mat.color}` : ''),
      unit: mat.unit || 'ea',
      unit_cost: Number(mat.quantity_unit_cost) || item.unit_cost,
    };
    onCommit(patch);
  };

  const handleMachinePick = (mId: string) => {
    const m = machines.find((x) => x.id === mId);
    if (!m) {
      onCommit({ machine_id: null });
      return;
    }
    const patch: Partial<LineItem> = {
      machine_id: m.id,
      description: `${m.name} · machine time`,
      unit: 'hr',
      unit_cost: Number(m.hourly_rate) || item.unit_cost,
    };
    onCommit(patch);
  };

  return (
    <div className="bg-henry-bg/40 border border-henry-border/20 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={item.kind}
          onChange={(e) => onCommit({ kind: e.target.value as LineItemKind })}
          className={`${smallInputCls} flex-shrink-0`}
        >
          {(Object.keys(KIND_LABELS) as LineItemKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>

        {showMaterialDropdown && materials.length > 0 && (
          <select
            value={item.material_id || ''}
            onChange={(e) => handleMaterialPick(e.target.value)}
            className={`${smallInputCls} flex-shrink-0 max-w-[180px]`}
          >
            <option value="">— pick material —</option>
            {materials.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.color ? ` · ${m.color}` : ''}
              </option>
            ))}
          </select>
        )}

        {showMachineDropdown && machines.length > 0 && (
          <select
            value={item.machine_id || ''}
            onChange={(e) => handleMachinePick(e.target.value)}
            className={`${smallInputCls} flex-shrink-0 max-w-[180px]`}
          >
            <option value="">— pick machine —</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}

        <input
          value={item.description}
          onChange={(e) => onChange({ description: e.target.value })}
          onBlur={() => onCommit({ description: item.description })}
          placeholder="Description"
          className={`${smallInputCls} flex-1 min-w-[160px]`}
        />

        <button
          onClick={onDelete}
          title="Remove"
          className="text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/10 transition-all flex-shrink-0"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-center">
        <div>
          <label className="text-[9px] uppercase tracking-wider text-henry-text-muted block">Qty</label>
          <input
            type="number"
            step="0.01"
            value={item.quantity}
            onChange={(e) => onChange({ quantity: parseFloat(e.target.value) || 0 })}
            onBlur={() => onCommit({ quantity: item.quantity })}
            className={smallInputCls + ' w-full'}
          />
        </div>
        <div>
          <label className="text-[9px] uppercase tracking-wider text-henry-text-muted block">Unit</label>
          <input
            value={item.unit}
            onChange={(e) => onChange({ unit: e.target.value })}
            onBlur={() => onCommit({ unit: item.unit })}
            className={smallInputCls + ' w-full'}
          />
        </div>
        <div>
          <label className="text-[9px] uppercase tracking-wider text-henry-text-muted block">Unit cost</label>
          <input
            type="number"
            step="0.01"
            value={item.unit_cost}
            onChange={(e) => onChange({ unit_cost: parseFloat(e.target.value) || 0 })}
            onBlur={() => onCommit({ unit_cost: item.unit_cost })}
            className={smallInputCls + ' w-full'}
          />
        </div>
        <div>
          <label className="text-[9px] uppercase tracking-wider text-henry-text-muted block">Line total</label>
          <p className="text-sm font-mono text-henry-text px-2 py-1.5">{fmtMoney(lineTotal(item))}</p>
        </div>
        <div>
          <label className="text-[9px] uppercase tracking-wider text-henry-text-muted block">Taxable</label>
          <button
            onClick={() => onCommit({ taxable: item.taxable ? 0 : 1 })}
            className={`text-xs px-2 py-1.5 rounded w-full transition-all ${
              item.taxable
                ? 'bg-henry-accent/15 text-henry-accent border border-henry-accent/30'
                : 'border border-henry-border/30 text-henry-text-muted'
            }`}
          >
            {item.taxable ? 'Yes' : 'No'}
          </button>
        </div>
      </div>
    </div>
  );
}
