/**
 * Chat attachments — the paperclip control on the composer, and the chips that
 * render on sent messages.
 *
 * Bytes live in the main process (attachments:* IPC); the renderer only ever
 * holds an id until it asks for a data URL to preview.
 */

import { useEffect, useRef, useState } from 'react';
import type { MessageAttachment } from '../../types';
import { toast } from '../ui/Toast';

const MAX_BYTES = 25 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function isImage(mime: string | null): boolean {
  return !!mime && mime.startsWith('image/');
}

/** Paperclip button + pending-attachment strip for the composer. */
export function AttachmentPicker({
  attachments,
  onAdd,
  onRemove,
  disabled,
}: {
  attachments: MessageAttachment[];
  onAdd: (files: File[]) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="shrink-0">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onAdd(files);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        title="Attach a file"
        aria-label="Attach a file"
        className="p-2 rounded-lg text-henry-text-muted hover:text-henry-text hover:bg-henry-surface disabled:opacity-40 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      {attachments.length > 0 && (
        <div className="absolute bottom-full left-0 mb-2 flex flex-wrap gap-1.5 px-1">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 max-w-[220px] px-2 py-1 rounded-lg bg-henry-surface border border-henry-border text-[11px] text-henry-text"
            >
              <span className="truncate">{a.file_name}</span>
              <span className="text-henry-text-muted shrink-0">{formatBytes(a.byte_size)}</span>
              <button
                type="button"
                onClick={() => onRemove(a.id)}
                title="Remove attachment"
                className="text-henry-text-muted hover:text-henry-text shrink-0"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Upload files through the attachment IPC. Returns the saved records. */
export async function uploadAttachments(
  files: File[],
  conversationId?: string,
): Promise<MessageAttachment[]> {
  const saved: MessageAttachment[] = [];
  for (const file of files) {
    if (file.size > MAX_BYTES) {
      toast.error(`${file.name} is ${formatBytes(file.size)} — the limit is 25 MB.`);
      continue;
    }
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const res = await window.henryAPI.saveAttachment({
        fileName: file.name,
        mimeType: file.type,
        data: buf,
        conversationId,
      });
      if (res.ok && res.attachment) {
        saved.push(res.attachment as MessageAttachment);
      } else {
        toast.error(res.error || `Could not attach ${file.name}.`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not attach ${file.name}.`);
    }
  }
  return saved;
}

/** Chips rendered under a sent message; click previews images, others open externally. */
export function MessageAttachmentList({ messageId }: { messageId: string }) {
  const [items, setItems] = useState<MessageAttachment[]>([]);
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.henryAPI
      .listAttachmentsForMessage(messageId)
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch(() => { /* attachments are optional */ });
    return () => { cancelled = true; };
  }, [messageId]);

  if (items.length === 0) return null;

  const open = async (a: MessageAttachment) => {
    if (isImage(a.mime_type)) {
      const res = await window.henryAPI.getAttachment(a.id);
      if (res.ok && res.dataUrl) setPreview({ url: res.dataUrl, name: a.file_name });
      else toast.error(res.error || 'Could not preview that image.');
      return;
    }
    const res = await window.henryAPI.openAttachment(a.id);
    if (!res.ok) toast.error(res.error || 'Could not open that file.');
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {items.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => void open(a)}
            title={`Open ${a.file_name}`}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-henry-surface border border-henry-border text-[11px] text-henry-text hover:border-henry-accent/50 transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            <span className="max-w-[180px] truncate">{a.file_name}</span>
            <span className="text-henry-text-muted">{formatBytes(a.byte_size)}</span>
          </button>
        ))}
      </div>

      {preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setPreview(null)}
        >
          <img
            src={preview.url}
            alt={preview.name}
            className="max-h-full max-w-full rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
