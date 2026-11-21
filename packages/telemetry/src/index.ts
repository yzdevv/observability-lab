export { shutdownTelemetry } from './sdk.ts';
export {
  SpanKind,
  currentTraceId,
  extractTraceContext,
  injectTraceContext,
  routeSpanHook,
  traceLogFields,
  tracer,
  withSpan,
} from './tracing.ts';
