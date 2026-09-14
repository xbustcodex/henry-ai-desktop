/**
 * Platform detection utility — uses preload-exposed platform API.
 * No Node 'os' module imports allowed in renderer code.
 */

let cachedPlatform: 'darwin' | 'linux' | 'win32' | 'web' | null = null;

/**
 * Get the current platform.
 * Uses the preload-exposed `window.henryAPI.platform()` which returns process.platform.
 * Falls back to navigator detection for web/SSR.
 */
export function getPlatform(): 'darwin' | 'linux' | 'win32' | 'web' {
  if (cachedPlatform !== null) return cachedPlatform;

  if (typeof window !== 'undefined') {
    // Try preload-exposed API first (Electron)
    const henryAPI = (window as any).henryAPI;
    if (henryAPI && typeof henryAPI.platform === 'function') {
      const p = henryAPI.platform();
      if (p === 'darwin' || p === 'linux' || p === 'win32') {
        cachedPlatform = p;
        return p;
      }
    }

    // Fallback: navigator-based detection (web/SSR)
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('mac')) {
      cachedPlatform = 'darwin';
    } else if (ua.includes('linux')) {
      cachedPlatform = 'linux';
    } else if (ua.includes('win')) {
      cachedPlatform = 'win32';
    } else {
      cachedPlatform = 'web';
    }
  } else {
    cachedPlatform = 'web';
  }

  return cachedPlatform!;
}

/**
 * Check if running on macOS
 */
export function isMacOS(): boolean {
  return getPlatform() === 'darwin';
}

/**
 * Check if running on Linux
 */
export function isLinux(): boolean {
  return getPlatform() === 'linux';
}

/**
 * Check if running on Windows
 */
export function isWindows(): boolean {
  return getPlatform() === 'win32';
}

/**
 * Get platform display name
 */
export function getPlatformName(): string {
  const p = getPlatform();
  switch (p) {
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    case 'win32': return 'Windows';
    default: return 'Web';
  }
}

/**
 * Reset cache (useful for testing)
 */
export function resetPlatformCache(): void {
  cachedPlatform = null;
}