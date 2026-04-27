import { describe, it, expect, afterEach } from 'bun:test';
import http from 'node:http';

import { startLocalProxy } from './local-proxy.js';

interface UpstreamHandle {
  port: number;
  stop: () => Promise<void>;
  requests: Array<{
    method: string;
    url: string;
    body: string;
    headers: Record<string, string | string[]>;
  }>;
}

/**
 * Start a fake upstream using `Bun.serve` (per the brief). Returns the
 * bound port + a stop helper + a record of every request that landed.
 *
 * `handler` is called with the parsed request body and must return the
 * Response to send back. Use `streamResponse(...)` below to test SSE
 * streaming behavior on the proxy.
 */
function startUpstream(
  handler: (
    req: Request,
    body: string,
  ) => Response | Promise<Response>,
): UpstreamHandle {
  const requests: UpstreamHandle['requests'] = [];

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text();
      const headers: Record<string, string | string[]> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      requests.push({
        method: req.method,
        url: new URL(req.url).pathname + new URL(req.url).search,
        body,
        headers,
      });
      return handler(req, body);
    },
  });

  return {
    port: server.port,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}

function sendThroughProxy(
  proxyPort: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...(extraHeaders || {}) };
    if (body !== undefined) {
      headers['content-type'] ||= 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Streams response chunks with a small delay between them — used to
 * verify the proxy forwards SSE-style streaming responses without
 * buffering the whole body.
 */
function streamThroughProxy(
  proxyPort: number,
  path: string,
): Promise<{ statusCode: number; chunks: Array<{ at: number; data: string }> }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const chunks: Array<{ at: number; data: string }> = [];
    const req = http.request(
      { hostname: '127.0.0.1', port: proxyPort, method: 'GET', path },
      (res) => {
        res.on('data', (c) => chunks.push({ at: Date.now() - start, data: c.toString() }));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, chunks }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const stoppers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const stop of stoppers.splice(0)) {
    await stop();
  }
});

describe('local-proxy', () => {
  it('forwards GET through to upstream and returns response', async () => {
    const upstream = startUpstream(() =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    stoppers.push(() => upstream.stop());

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });
    stoppers.push(() => proxy.stop());

    const resp = await sendThroughProxy(proxy.port, 'GET', '/g/abc/v1/models');
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body)).toEqual({ ok: true });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0].url).toBe('/g/abc/v1/models');
  });

  it('forwards POST body intact and rewrites host header', async () => {
    const upstream = startUpstream((_req, body) => new Response(`echo:${body}`, { status: 201 }));
    stoppers.push(() => upstream.stop());

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });
    stoppers.push(() => proxy.stop());

    const resp = await sendThroughProxy(
      proxy.port,
      'POST',
      '/v1/messages',
      '{"prompt":"hi"}',
    );
    expect(resp.statusCode).toBe(201);
    expect(resp.body).toBe('echo:{"prompt":"hi"}');
    // host header must point at the upstream, not at the proxy
    expect(upstream.requests[0].headers.host).toBe(`127.0.0.1:${upstream.port}`);
  });

  it('passes custom headers through unchanged', async () => {
    const upstream = startUpstream(() => new Response('ok', { status: 200 }));
    stoppers.push(() => upstream.stop());

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });
    stoppers.push(() => proxy.stop());

    await sendThroughProxy(proxy.port, 'GET', '/v1/x', undefined, {
      'x-api-key': 'sk-test-123',
      'anthropic-version': '2023-06-01',
      'x-trace-id': 'abc-def',
    });

    const got = upstream.requests[0].headers;
    expect(got['x-api-key']).toBe('sk-test-123');
    expect(got['anthropic-version']).toBe('2023-06-01');
    expect(got['x-trace-id']).toBe('abc-def');
  });

  it('streams response body without full buffering (SSE-style)', async () => {
    const upstream = startUpstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode('chunk-1\n'));
              await new Promise((r) => setTimeout(r, 80));
              controller.enqueue(enc.encode('chunk-2\n'));
              await new Promise((r) => setTimeout(r, 80));
              controller.enqueue(enc.encode('chunk-3\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    stoppers.push(() => upstream.stop());

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });
    stoppers.push(() => proxy.stop());

    const resp = await streamThroughProxy(proxy.port, '/v1/messages?stream=true');
    expect(resp.statusCode).toBe(200);
    // Should see 3 distinct chunks; the second + third must arrive at
    // measurably different times — proves we're not buffering.
    const all = resp.chunks.map((c) => c.data).join('');
    expect(all).toBe('chunk-1\nchunk-2\nchunk-3\n');
    // At least one inter-chunk gap must be > 30ms (we sleep 80ms upstream).
    if (resp.chunks.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < resp.chunks.length; i++) {
        gaps.push(resp.chunks[i].at - resp.chunks[i - 1].at);
      }
      expect(Math.max(...gaps)).toBeGreaterThan(30);
    }
  });

  it('retries ECONNREFUSED until upstream comes back', async () => {
    // Reserve a port by binding then stopping a placeholder.
    const placeholder = startUpstream(() => new Response('placeholder'));
    const upstreamPort = placeholder.port;
    await placeholder.stop();

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      retryDelaysMs: [20, 20, 20, 20, 20, 20, 20, 20],
      maxRetryWindowMs: 5000,
    });
    stoppers.push(() => proxy.stop());

    const respPromise = sendThroughProxy(proxy.port, 'GET', '/v1/ping');

    // Bring the upstream up after a short delay so the proxy has to retry.
    await new Promise((r) => setTimeout(r, 80));
    const real: { server: ReturnType<typeof Bun.serve>; requests: number } = {
      server: Bun.serve({
        port: upstreamPort,
        hostname: '127.0.0.1',
        fetch() {
          real.requests += 1;
          return new Response('up', { status: 200 });
        },
      }),
      requests: 0,
    };
    stoppers.push(async () => {
      await real.server.stop(true);
    });

    const resp = await respPromise;
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe('up');
    expect(real.requests).toBe(1);
  });

  it('returns 502 when retry window expires with upstream down', async () => {
    // Reserve an unbound port.
    const placeholder = startUpstream(() => new Response('placeholder'));
    const upstreamPort = placeholder.port;
    await placeholder.stop();

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      retryDelaysMs: [30],
      maxRetryWindowMs: 150,
    });
    stoppers.push(() => proxy.stop());

    const resp = await sendThroughProxy(proxy.port, 'GET', '/v1/x');
    expect(resp.statusCode).toBe(502);
    expect(resp.body).toMatch(/local_proxy_error/);
  });

  it('propagates upstream 500 without retry', async () => {
    let hits = 0;
    const upstream = startUpstream(() => {
      hits += 1;
      return new Response('boom', { status: 500 });
    });
    stoppers.push(() => upstream.stop());

    const proxy = await startLocalProxy({
      port: 0,
      upstreamUrl: `http://127.0.0.1:${upstream.port}`,
    });
    stoppers.push(() => proxy.stop());

    const resp = await sendThroughProxy(proxy.port, 'GET', '/v1/x');
    expect(resp.statusCode).toBe(500);
    expect(resp.body).toBe('boom');
    expect(hits).toBe(1);
  });

  it('rejects non-http upstream URL', async () => {
    let err: Error | undefined;
    try {
      await startLocalProxy({ port: 0, upstreamUrl: 'https://api.anthropic.com' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message || '').toMatch(/http:\/\//);
  });
});
