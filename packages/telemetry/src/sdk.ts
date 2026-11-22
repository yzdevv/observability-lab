import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';

// Health checks run every few seconds; tracing them would bury the interesting traces.
const UNTRACED_PATHS = new Set(['/healthz']);

let sdk: NodeSDK | undefined;

// Service name, endpoint and resource attributes come from the standard OTEL_* environment variables.
export function startTelemetry(): void {
  if (sdk || process.env.OTEL_SDK_DISABLED === 'true') return;
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => UNTRACED_PATHS.has((req.url ?? '').split('?')[0] ?? ''),
      }),
      new UndiciInstrumentation({ requireParentforSpans: true }),
      // requireParentSpan: no root spans from background work such as the worker's blocking
      // XREADGROUP poll, which would otherwise create a trace every 5 seconds.
      // Connect spans stay on: pg-pool.connect is the wait for a free pool connection, the
      // equivalent of pgx's pool.acquire, and shows when a slow query starves the pool.
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();
}

// Flush buffered spans before the process exits.
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => {});
}
