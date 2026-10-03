/**
 * PrimeTech marketplace — a browser for the shared `marketplace.json`
 * catalogue. Catalogue metadata comes from the manifest; the installed /
 * available / unavailable badge is real runtime state reported by the main
 * process, never inferred in the UI.
 */

import ToolIcon from './ToolIcon';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CatalogEntry,
  CatalogEntryState,
  CatalogListing,
} from '../../types';
import { toast } from '../ui/Toast';

const STATE_BADGE: Record<CatalogEntryState, { label: string; cls: string }> = {
  installed: { label: 'Fetched', cls: 'bg-emerald-500/15 text-emerald-400' },
  available: { label: 'Available', cls: 'bg-sky-500/15 text-sky-400' },
  unavailable: { label: 'No download', cls: 'bg-henry-surface text-henry-text-muted' },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function MarketplacePanel() {
  const [listing, setListing] = useState<CatalogListing | null>(null);
  const [states, setStates] = useState<Record<string, CatalogEntryState>>({});
  const [query, setQuery] = useState('');
  const [type, setType] = useState<string>('all');
  const [category, setCategory] = useState<string>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, s] = await Promise.all([
        window.henryAPI.marketplaceList?.(),
        window.henryAPI.marketplaceStates?.(),
      ]);
      if (l) setListing(l);
      if (s) setStates(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const types = useMemo(() => {
    const t = new Set<string>();
    for (const e of listing?.entries ?? []) t.add(e.type);
    return [...t].sort();
  }, [listing]);

  const categories = useMemo(() => {
    const c = new Set<string>();
    for (const e of listing?.entries ?? []) c.add(e.category);
    return [...c].sort();
  }, [listing]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listing?.entries ?? []).filter((e) => {
      if (type !== 'all' && e.type !== type) return false;
      if (category !== 'all' && e.category !== category) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.id.includes(q) ||
        (e.author ?? '').toLowerCase().includes(q) ||
        (e.capabilities ?? []).some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [listing, query, type, category]);

  const fetchEntry = async (entry: CatalogEntry) => {
    setBusy(entry.id);
    try {
      const res = await window.henryAPI.marketplaceFetch?.(entry.id);
      if (!res?.ok) { toast.error(res?.error || 'Download failed'); return; }
      toast.success(`Fetched ${res.name} (${formatBytes(res.byteSize ?? 0)}) to your Downloads`);
      void load();
    } finally {
      setBusy(null);
    }
  };

  const openEntry = async (entry: CatalogEntry) => {
    const res = await window.henryAPI.marketplaceOpenEntry?.(entry.id);
    if (res && !res.ok) toast.error(res.error || 'Could not open that entry.');
  };

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h1 className="text-lg font-bold text-henry-text">Marketplace</h1>
          <p className="text-[11px] text-henry-text-muted mt-0.5">
            {listing
              ? `${listing.manifest} · manifest v${listing.version} · ${listing.entries.length} entries`
              : 'Loading the catalogue…'}
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="px-2.5 py-1.5 rounded-lg text-xs border border-henry-border/40 text-henry-text hover:border-henry-accent/50"
        >
          Refresh
        </button>
      </div>
      <p className="text-[11px] text-henry-text-muted mb-3">
        The same catalogue the PrimeTech apps use. Downloads are fetched to your
        Downloads folder — this never installs or runs anything on your machine.
      </p>

      {listing && listing.problems.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-[11px] text-amber-300 font-medium mb-1">
            {listing.problems.length} problem{listing.problems.length === 1 ? '' : 's'} reading the manifest
          </p>
          <ul className="text-[10px] text-henry-text-muted space-y-0.5">
            {listing.problems.map((p, i) => <li key={i}>• {p}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tools, capabilities, authors…"
          className="flex-1 min-w-[200px] bg-henry-bg border border-henry-border/30 rounded-lg px-3 py-1.5 text-xs text-henry-text placeholder:text-henry-text-muted outline-none focus:border-henry-accent/50"
        />
        <select value={type} onChange={(e) => setType(e.target.value)}
          className="bg-henry-bg border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text">
          <option value="all">All types</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)}
          className="bg-henry-bg border border-henry-border/30 rounded-lg px-2 py-1.5 text-xs text-henry-text">
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-henry-text-muted">Loading the catalogue…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-henry-text-muted">Nothing matches those filters.</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2">
          {visible.map((entry) => {
            const state = states[entry.id] ?? 'unavailable';
            const badge = STATE_BADGE[state];
            const expanded = openId === entry.id;
            return (
              <div key={entry.id} className="rounded-2xl border border-henry-border/25 bg-henry-surface/25 p-3.5">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="min-w-0 flex items-start gap-2">
                    <ToolIcon name={entry.name} />
                    <div className="min-w-0">
                    <p className="text-sm font-semibold text-henry-text truncate">{entry.name}</p>
                    <p className="text-[10px] text-henry-text-muted">
                      {entry.type} · {entry.category}
                      {entry.version ? ` · v${entry.version}` : ''}
                      {entry.author ? ` · ${entry.author}` : ''}
                    </p>
                    </div>
                  </div>
                  <span className={`shrink-0 text-[9px] px-1.5 py-0.5 rounded-full ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>

                <p className="text-[11px] text-henry-text-muted leading-relaxed line-clamp-2">
                  {entry.description}
                </p>

                {(entry.capabilities?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(entry.capabilities ?? []).slice(0, 4).map((c) => (
                      <span key={c} className="text-[9px] px-1.5 py-0.5 rounded bg-henry-surface text-henry-text-muted">
                        {c}
                      </span>
                    ))}
                  </div>
                )}

                {expanded && (
                  <dl className="mt-2.5 space-y-1 text-[10px]">
                    {entry.packageName && (<><dt className="inline text-henry-text-muted">package: </dt><dd className="inline text-henry-text">{entry.packageName}</dd></>)}
                    {entry.homepage && (<><dt className="inline text-henry-text-muted">home: </dt><dd className="inline text-henry-text break-all">{entry.homepage}</dd></>)}
                    {entry.repository && (<><dt className="inline text-henry-text-muted">repo: </dt><dd className="inline text-henry-text break-all">{entry.repository}</dd></>)}
                    {(entry.integrations?.length ?? 0) > 0 && (<><dt className="inline text-henry-text-muted">integrates: </dt><dd className="inline text-henry-text">{entry.integrations!.join(', ')}</dd></>)}
                    {entry.requirements && Object.keys(entry.requirements).length > 0 && (
                      <><dt className="inline text-henry-text-muted">requires: </dt>
                      <dd className="inline text-henry-text">
                        {Object.entries(entry.requirements).map(([k, v]) => `${k}=${String(v)}`).join(', ')}
                      </dd></>
                    )}
                  </dl>
                )}

                <div className="flex flex-wrap gap-1.5 mt-3">
                  {entry.install?.type === 'none' ? (
                    <span className="text-[10px] text-henry-text-muted self-center">
                      Nothing to download — this entry is informational.
                    </span>
                  ) : (
                    <button
                      onClick={() => void fetchEntry(entry)}
                      disabled={busy === entry.id}
                      className="px-2.5 py-1 rounded-lg text-[11px] bg-henry-accent text-white disabled:opacity-40"
                    >
                      {busy === entry.id ? 'Fetching…' : entry.install.type === 'termux-run' ? 'Fetch script' : 'Fetch package'}
                    </button>
                  )}
                  <button
                    onClick={() => void openEntry(entry)}
                    className="px-2.5 py-1 rounded-lg text-[11px] border border-henry-border/40 text-henry-text hover:border-henry-accent/50"
                  >
                    {state === 'installed' ? 'Show file' : 'Open page'}
                  </button>
                  <button
                    onClick={() => setOpenId(expanded ? null : entry.id)}
                    className="px-2.5 py-1 rounded-lg text-[11px] text-henry-text-muted hover:text-henry-text"
                  >
                    {expanded ? 'Less' : 'Details'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
