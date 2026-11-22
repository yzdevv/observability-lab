import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { registerCgroupMetrics } from './cgroup.ts';

// Health checks run every few seconds; tracing them would bury the interesting traces.
const UNTRACED_PATHS = new Set(['/healthz']);

let sdk: NodeSDK | undefined;

const enabled = (signal: 'METRICS' | 'LOGS') => (process.env[`OTEL_${signal}_EXPORTER`] ?? 'otlp') !== 'none';

// Service name, endpoint and resource attributes come from the standard OTEL_* environment variables.
export function startTelemetry(): void {
  if (sdk || process.env.OTEL_SDK_DISABLED === 'true') return;
  sdk = new NodeSDK({
    // lab.impl on the resource, as in Go, so every span metric of an order service carries it.
    resource: process.env.LAB_IMPL ? resourceFromAttributes({ 'lab.impl': process.env.LAB_IMPL }) : undefined,
    traceExporter: new OTLPTraceExporter(),
    metricReaders: enabled('METRICS')
      ? [new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
          exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 10_000),
        })]
      : [],
    logRecordProcessors: enabled('LOGS') ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })] : [],
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
      // Sends pino log records over OTLP (to Loki) with the active trace and span IDs. The
      // trace_id/span_id fields in stdout JSON come from our own mixin (traceLogFields).
      new PinoInstrumentation({ disableLogCorrelation: true }),
      // Event-loop delay and utilisation, GC, heap: the Node runtime numbers next to Go's.
      new RuntimeNodeInstrumentation({ monitoringPrecision: 5000 }),
    ],
  });
  sdk.start();
  if (enabled('METRICS')) registerCgroupMetrics();
}

// Flush buffered telemetry before the process exits.
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => {});
}
