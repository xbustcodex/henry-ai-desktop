/**
 * Media library panel — a browsable shelf of imported images, audio and
 * documents. Images preview inline, audio plays, and anything can be opened in
 * its default app or revealed in the file manager.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MediaItem, MediaKind } from '../../types';
import { toast } from '../ui/Toast';

const KIND_LABEL: Record<MediaKind, string> = {
  image: 'Images',
  audio: 'Audio',
  document: 'Documents',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export default function MediaLibraryPanel() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [counts, setCounts] = useState<Record<MediaKind, number>>({ image: 0, audio: 0, document: 0 });
  const [filter, setFilter] = useState<MediaKind | 'all'>('all');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, c] = await Promise.all([
        window.henryAPI.mediaList?.({ limit: 200 }) ?? Promise.resolve([] as MediaItem[]),
        window.henryAPI.mediaCounts?.() ?? Promise.resolve({ image: 0, audio: 0, document: 0 }),
      ]);
      setItems(list);
      setCounts(c);
    } catch {
      /* the panel degrades to empty rather than breaking the app */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const importMedia = async (kind: MediaKind) => {
    setBusy(true);
    try {
      const res = await window.henryAPI.mediaImport?.({ kind });
      if (!res?.ok) { toast.error(res?.error || 'Import failed'); return; }
      if (res.cancelled) return;
      if (res.imported.length === 0 && res.skipped?.length) {
        toast.error(`Skipped: ${res.skipped.join(', ')}`);
        return;
      }
      toast.success(`Imported ${res.imported.length} file${res.imported.length === 1 ? '' : 's'}`);
      if (res.skipped?.length) toast.error(`Skipped: ${res.skipped.join(', ')}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openItem = async (item: MediaItem) => {
    if (item.kind === 'image' || item.kind === 'audio') {
      const res = await window.henryAPI.mediaGet?.(item.id);
      if (res?.ok && res.dataUrl) { setPreview({ url: res.dataUrl, name: item.file_name }); return; }
      toast.error(res?.error || 'Could not load that file.');
      return;
    }
    const res = await window.henryAPI.mediaOpen?.(item.id);
    if (res && !res.ok) toast.error(res.error || 'Could not open that file.');
  };

  const remove = async (item: MediaItem) => {
    const res = await window.henryAPI.mediaDelete?.(item.id);
    // `mediaDelete` RESOLVES with `{ok:false, error}` for a malformed id, a
    // file that is already gone, or a permissions error — it does not throw.
    // Awaiting it and reloading regardless meant the panel re-rendered as if the
    // delete had worked: the item was still listed, and nothing said why.
    // `importMedia` and `openItem` above both check `res?.ok`; this one did not.
    if (!res?.ok) { toast.error(res?.error || 'Could not delete that item.'); return; }
    await load();
  };

  const visible = filter === 'all' ? items : items.filter((i) => i.kind === filter);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-lg font-bold text-henry-text">Media</h1>
        <div className="flex gap-1.5">
          <button
            onClick={() => void importMedia('image')}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-henry-accent text-white disabled:opacity-40"
          >
            + Images
          </button>
          <button
            onClick={() => void importMedia('audio')}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-henry-border/40 text-henry-text hover:border-henry-accent/50 disabled:opacity-40"
          >
            + Audio
          </button>
          <button
            onClick={() => void importMedia('document')}
            disabled={busy}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-henry-border/40 text-henry-text hover:border-henry-accent/50 disabled:opacity-40"
          >
            + Files
          </button>
        </div>
      </div>
      <p className="text-[11px] text-henry-text-muted mb-3">
        Files are copied into Henry's own storage, so the library keeps working if the originals move.
      </p>

      <div className="flex gap-1.5 mb-3">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`All (${items.length})`} />
        {(Object.keys(KIND_LABEL) as MediaKind[]).map((k) => (
          <FilterChip
            key={k}
            active={filter === k}
            onClick={() => setFilter(k)}
            label={`${KIND_LABEL[k]} (${counts[k] ?? 0})`}
          />
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-henry-text-muted">Loading your media…</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-henry-text-muted">
          Nothing here yet. Import images, audio or documents and they show up on this shelf.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {visible.map((item) => (
            <div key={item.id} className="rounded-xl border border-henry-border/25 bg-henry-surface/30 overflow-hidden group">
              <button
                onClick={() => void openItem(item)}
                className="w-full aspect-video flex items-center justify-center bg-henry-bg/60 hover:bg-henry-bg transition-colors"
                title={`Open ${item.file_name}`}
              >
                <span className="text-2xl">
                  {item.kind === 'image' ? '🖼️' : item.kind === 'audio' ? '🎵' : '📄'}
                </span>
              </button>
              <div className="p-2">
                <p className="text-[11px] text-henry-text truncate" title={item.file_name}>{item.file_name}</p>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-henry-text-muted">{formatBytes(item.byte_size)}</span>
                  <span className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => void window.henryAPI.mediaReveal?.(item.id)}
                      title="Show in file manager"
                      className="text-[10px] text-henry-text-muted hover:text-henry-text"
                    >
                      reveal
                    </button>
                    <button
                      onClick={() => void remove(item)}
                      title="Remove from library"
                      className="text-[10px] text-red-400/80 hover:text-red-400"
                    >
                      remove
                    </button>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6" onClick={() => setPreview(null)}>
          <div className="max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
            <p className="text-xs text-white/70 mb-2 text-center">{preview.name}</p>
            {/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(preview.name) ? (
              <audio src={preview.url} controls autoPlay className="w-full" />
            ) : (
              <img src={preview.url} alt={preview.name} className="max-h-[80vh] mx-auto rounded-xl" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-[11px] border transition-colors ${
        active ? 'border-henry-accent/60 text-henry-accent' : 'border-henry-border/30 text-henry-text-muted hover:text-henry-text'
      }`}
    >
      {label}
    </button>
  );
}
