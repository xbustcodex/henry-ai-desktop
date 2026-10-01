/**
 * Clipboard write that cannot produce an unhandled rejection.
 *
 * `navigator.clipboard.writeText` rejects with "Document is not focused" when
 * the window is in the background or was never focused, and a bare call turns
 * that into an unhandled rejection on every copy button. Callers still get a
 * truthful boolean so they can show a real failure state.
 */
export async function safeCopyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      // Fall back to the pre-permission API, which has no focus requirement.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
