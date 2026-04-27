/**
 * In-container retry proxy for the host credential proxy / OneCLI gateway.
 *
 * The host's credential proxy (e.g. OneCLI gateway, or `src/credential-proxy.ts`)
 * injects auth headers and forwards to api.anthropic.com. When the host
 * process restarts, the upstream port briefly goes away and any in-flight
 * Agent SDK request fails with `ECONNREFUSED`.
 *
 * This proxy runs inside the container, listens on 127.0.0.1, and retries
 * `ECONNREFUSED` (and a handful of related transient network errors) against
 * the host with exponential backoff. The Agent SDK inside the container
 * never sees transient host outages.
 *
 * Request body is buffered once and replayed on retry — Anthropic request
 * bodies are small JSON. The response is piped (`upstreamRes.pipe(res)`)
 * with no intermediate buffer so SSE responses stream through unchanged.
 *
 * Runtime note: Bun supports `node:http` natively, and the streaming
 * semantics we need are a much closer match to Node's `http.IncomingMessage`
 * pipe model than to `Bun.serve`'s Web-`Response` body. Using `node:http`
 * here keeps the code identical to the v1 port and avoids re-implementing
 * retry-on-error against `fetch`'s opaque stream lifecycle.
 */

import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { URL } from 'node:url';

/**
 * Backoff schedule from the brief: 250ms, 500ms, 1s, 2s, 4s, 8s capped,
 * total ~60s before giving up. After attempt 5 (8s) we cap and keep
 * sleeping 8s per attempt until the 60s window expires.
 */
const DEFAULT_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
const DEFAULT_MAX_RETRY_WINDOW_MS = 60 * 1000;

const RETRIABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

export interface LocalProxyOptions {
  port: number;
  upstreamUrl: string;
  log?: (msg: string) => void;
  /** Override retry backoff schedule (ms per attempt, last value repeats). */
  retryDelaysMs?: number[];
  /** Override total retry window before giving up with 502. */
  maxRetryWindowMs?: number;
}

export interface RunningLocalProxy {
  server: Server;
  port: number;
  stop: () => Promise<void>;
}

export function startLocalProxy(opts: LocalProxyOptions): Promise<RunningLocalProxy> {
  const upstream = new URL(opts.upstreamUrl);
  if (upstream.protocol !== 'http:') {
    return Promise.reject(
      new Error(`local-proxy only supports http:// upstream, got ${upstream.protocol}`),
    );
  }
  const log = opts.log || (() => {});
  const retryDelays = opts.retryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
  const maxRetryWindowMs = opts.maxRetryWindowMs ?? DEFAULT_MAX_RETRY_WINDOW_MS;

  const server = createServer((req, res) => {
    handleRequest(req, res, upstream, log, retryDelays, maxRetryWindowMs).catch((err) => {
      log(
        `local-proxy handler error: ${err instanceof Error ? err.stack || err.message : String(err)}`,
      );
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            error: {
              type: 'local_proxy_error',
              message: err instanceof Error ? err.message : 'unknown local proxy error',
            },
          }),
        );
      } else {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`local-proxy listening on 127.0.0.1:${boundPort} -> ${upstream.origin}`);
      resolve({
        server,
        port: boundPort,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: URL,
  log: (msg: string) => void,
  retryDelays: number[],
  maxRetryWindowMs: number,
): Promise<void> {
  // Buffer the request body once so we can replay on retry. Anthropic
  // request bodies are JSON prompt payloads — small. SSE streaming is on
  // the *response* side, which we pipe (no buffering).
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const started = Date.now();
  let attempt = 0;
  let lastErr: Error | null = null;

  while (Date.now() - started < maxRetryWindowMs) {
    try {
      await forwardOnce(req, res, body, upstream);
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!code || !RETRIABLE_CODES.has(code)) {
        throw lastErr;
      }
      if (res.headersSent) {
        // Response already started streaming — cannot retry cleanly.
        throw lastErr;
      }
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      log(
        `local-proxy retry attempt=${attempt + 1} code=${code} sleeping=${delay}ms url=${req.url}`,
      );
      await sleep(delay);
      attempt += 1;
    }
  }

  throw lastErr || new Error('local-proxy exhausted retry window');
}

function forwardOnce(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
  upstream: URL,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Forward headers verbatim except `host` (must point at the upstream)
    // and `content-length` (set from the buffered body so the upstream
    // gets the correct length even if the original request was chunked).
    const forwardedHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (k.toLowerCase() === 'host') continue;
      forwardedHeaders[k] = v as string | string[];
    }
    forwardedHeaders.host = upstream.host;
    forwardedHeaders['content-length'] = String(body.length);

    const upstreamReq = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        method: req.method,
        // Preserve the incoming path/query exactly (any /g/<jid>/ prefix
        // the host credential proxy expects for group attribution).
        path: req.url,
        headers: forwardedHeaders,
      },
      (upstreamRes) => {
        res.statusCode = upstreamRes.statusCode || 502;
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (v !== undefined) res.setHeader(k, v as string | string[]);
        }
        upstreamRes.on('error', reject);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => resolve());
      },
    );

    upstreamReq.on('error', reject);
    upstreamReq.write(body);
    upstreamReq.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
