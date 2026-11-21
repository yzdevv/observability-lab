import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';

export { SpanKind };

export const tracer = trace.getTracer('observability-lab');

type SpanOptions = { attributes?: Attributes; kind?: SpanKind; parent?: Context };

// Runs fn inside a new active span. Server errors (no status, or status >= 500) mark the span as
// failed; client errors (4xx) are recorded as an attribute only, since the service behaved correctly.
export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const { attributes, kind = SpanKind.INTERNAL, parent = context.active() } = options;
  return tracer.startActiveSpan(name, { attributes, kind }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status && status < 500) {
        span.setAttribute('lab.client_error', status);
      } else {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

export function currentTraceId(): string | undefined {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && trace.isSpanContextValid(ctx) ? ctx.traceId : undefined;
}

// Fields merged into every log line so logs can be joined to traces.
export function traceLogFields(): Record<string, string> {
  const ctx = trace.getActiveSpan()?.spanContext();
  if (!ctx || !trace.isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

// W3C trace context as plain fields, for carrying through a message queue.
export function injectTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function extractTraceContext(carrier: Record<string, string>): Context {
  return propagation.extract(ROOT_CONTEXT, carrier);
}

// Fastify onRequest hook: name the HTTP server span after the route template and return the
// trace id to the client, so a browser can look up its own trace.
export async function routeSpanHook(
  req: { method: string; routeOptions: { url?: string } },
  reply: { header(key: string, value: string): unknown },
): Promise<void> {
  const span = trace.getActiveSpan();
  if (!span) return;
  const route = req.routeOptions.url;
  if (route) {
    span.updateName(`${req.method} ${route}`);
    span.setAttribute('http.route', route);
  }
  reply.header('x-trace-id', span.spanContext().traceId);
}
