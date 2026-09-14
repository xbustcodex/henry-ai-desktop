import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import https from 'https';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

// ── AI Proxy Plugin ──────────────────────────────────────────────────────────
// Manually proxies /proxy/{provider}/* → external API server-side.
//
// Only providers that BLOCK browser CORS are listed here — all others are
// called directly from the browser (OpenAI, OpenRouter, Google, Groq all
// support browser CORS natively and are fetched directly in webMock.ts).
//
// Active proxy routes (only services that BLOCK browser CORS remain here):
//
//   /proxy/anthropic  — Anthropic blocks CORS at their edge; static-safe fallback
//                       error thrown by anthropicFetch() in webMock.ts
//   /proxy/ddg        — DuckDuckGo CORS unreliable; webSearch.ts falls back to
//                       public CORS proxies (corsproxy.io, allorigins) if 404
//
// Productivity services that block CORS (dev-mode only):
//   /proxy/notion     — Notion blocks browser CORS; notionSearch() throws clear error if 404
//   /proxy/stripe     — Stripe blocks browser CORS; stripeFetch() throws clear error if 404
//   /proxy/gcal       — Google Calendar (not yet called from browser code)
//   /proxy/gmail      — Gmail (not yet called from browser code)
//
// REMOVED — now use direct browser CORS calls:
//   github.com  → ghFetch() in integrations.ts calls https://api.github.com directly
//   linear.app  → linearQuery() in integrations.ts calls https://api.linear.app directly
//   Slack       → slackFetch() calls https://slack.com/api/ with stored Bot Token
const routes: Record<string, string> = {
  '/proxy/anthropic':   'api.anthropic.com',
  '/proxy/ddg':         'api.duckduckgo.com',
  '/proxy/notion':      'api.notion.com',
  '/proxy/stripe':      'api.stripe.com',
  '/proxy/gcal':        'www.googleapis.com',
  '/proxy/gmail':       'gmail.googleapis.com',
};

function aiProxyPlugin(): Plugin {
  return {
    name: 'henry-ai-proxy',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = req.url ?? '';
        const entry = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
        if (!entry) return next();

        const [prefix, host] = entry;
        const upstreamPath = url.slice(prefix.length) || '/';

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          console.log(`[henry-proxy] ${req.method} ${url} → ${host} (body: ${body.length}b)`);

          // Forward all original headers except host
          const forwardHeaders: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            if (k.toLowerCase() !== 'host') forwardHeaders[k] = v as string;
          }
          // Remove browser-level CORS hints that upset some APIs
          delete forwardHeaders['origin'];
          delete forwardHeaders['referer'];

          const options: https.RequestOptions = {
            hostname: host,
            port: 443,
            path: upstreamPath,
            method: req.method,
            headers: {
              ...forwardHeaders,
              host,
              'content-length': body.length,
              // Force plain uncompressed responses — the proxy pipes the raw
              // bytes straight to the browser, so gzip would arrive garbled.
              'accept-encoding': 'identity',
            },
          };

          // Handle CORS preflight from sandboxed iframes
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
              'Access-Control-Allow-Headers': '*',
              'Access-Control-Max-Age': '86400',
            });
            res.end();
            return;
          }

          const upstream = https.request(options, (upRes) => {
            const status = upRes.statusCode ?? 200;
            console.log(`[henry-proxy] ← ${status} ${upRes.headers['content-type'] ?? ''}`);

            const outHeaders: Record<string, string | string[]> = {};
            // Copy safe headers — skip hop-by-hop and encoding headers that
            // would confuse the browser or the Replit proxy layer.
            const skipHeaders = new Set([
              'content-encoding',   // prevent gzip garbling
              'content-length',     // length is invalid after re-framing
              'connection',
              'keep-alive',
              'proxy-authenticate',
              'proxy-authorization',
              'te',
              'trailers',
              'upgrade',
            ]);
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (!skipHeaders.has(k.toLowerCase()) && v !== undefined) {
                outHeaders[k] = v as string | string[];
              }
            }
            // Always allow cross-origin access (Replit workspace iframes run
            // with opaque origins so every request looks cross-origin)
            outHeaders['access-control-allow-origin'] = '*';
            outHeaders['access-control-allow-headers'] = '*';
            // Keep transfer-encoding: chunked so Replit's reverse proxy knows
            // to stream each chunk rather than buffer the whole response.
            if (!outHeaders['transfer-encoding']) {
              outHeaders['transfer-encoding'] = 'chunked';
            }

            res.writeHead(status, outHeaders);

            // Pipe upstream → response; handle errors gracefully so an
            // upstream drop doesn't leave the client hanging forever.
            upRes.pipe(res);
            upRes.on('error', (pipeErr) => {
              console.error('[henry-proxy] upstream pipe error:', pipeErr.message);
              try { res.end(); } catch { /* already closed */ }
            });
          });

          upstream.on('error', (err) => {
            console.error('[henry-proxy] upstream connect error:', err.message);
            if (!res.headersSent) {
              res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });

          upstream.write(body);
          upstream.end();
        });
      });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  plugins: [react(), aiProxyPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Redirect native-only barcode scanner to a web stub so the dev server
      // and production build don't fail trying to resolve the native package.
      '@capacitor-mlkit/barcode-scanning': path.resolve(
        __dirname,
        './src/stubs/barcodeScanning.ts'
      ),
    },
  },
  define: {
    // Expose GROQ_API_KEY from server env into browser bundle so Henry can
    // auto-bootstrap the Groq provider without the setup wizard.
    __GROQ_API_KEY__: JSON.stringify(process.env.GROQ_API_KEY || ''),
  },
  // ── Native-only Capacitor plugins ─────────────────────────────────────────
  // These packages are native-only and are only dynamically imported by
  // mobile companion screens. Exclude them from both the dev optimizer
  // (esbuild scan) and the production Rollup bundle.
  optimizeDeps: {
    exclude: ['@capacitor-mlkit/barcode-scanning'],
  },
  build: {
    rollupOptions: {
      external: [
        '@capacitor-mlkit/barcode-scanning',
      ],
      output: {
        manualChunks(id) {
          // All node_modules go into a single vendor chunk for stable caching.
          // Splitting react-dom from the rest creates circular deps between chunks.
          if (id.includes('node_modules/')) {
            return 'vendor';
          }
          // App split: scripture / Bible corpus (large data)
          if (id.includes('/henry/scripture') || id.includes('/henry/biblicalProfiles') || id.includes('/henry/scriptureImport')) {
            return 'bible';
          }
          // App split: heavy UI panels that are navigated to, not always visible
          if (id.includes('/components/workspace/') || id.includes('/components/terminal/') || id.includes('/components/recorder/')) {
            return 'panels-heavy';
          }
          // App split: integration panels
          if (id.includes('/components/integrations/') || id.includes('/henry/integrations')) {
            return 'panels-integrations';
          }
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
    hmr: {
      // Extend timeout so rapid streaming re-renders (many chunk updates/sec)
      // don't cause the HMR WebSocket to drop and trigger a full page reload.
      timeout: 120000,
    },
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  },
});
