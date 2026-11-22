// Live RED numbers for the public page, from the span metrics in Prometheus. One query set per
// 10 s at most, shared by every visitor, so the page cannot turn into load on Prometheus.
import { config, IMPLS, type Impl } from './config.ts';

export type ImplStats = {
  /** Order requests per second through the gateway (all scenarios). */
  rps: number | null;
  /** Share of order requests that did not get 202, in percent. */
  errorPct: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};
export type LabStats = { window: string; at: string; impls: Record<Impl, ImplStats> };

const WINDOW = '5m';
const SEL = `service_name="gateway", span_kind="SPAN_KIND_SERVER", span_name="POST /api/:impl/orders"`;
const QUERIES = {
  rps: `sum by (lab_impl) (rate(traces_span_metrics_calls_total{${SEL}}[${WINDOW}]))`,
  errorPct: `100 * sum by (lab_impl) (rate(traces_span_metrics_calls_total{${SEL}, http_response_status_code!="202"}[${WINDOW}])) / sum by (lab_impl) (rate(traces_span_metrics_calls_total{${SEL}}[${WINDOW}]))`,
  p50Ms: `histogram_quantile(0.5, sum by (le, lab_impl) (rate(traces_span_metrics_duration_milliseconds_bucket{${SEL}}[${WINDOW}])))`,
  p95Ms: `histogram_quantile(0.95, sum by (le, lab_impl) (rate(traces_span_metrics_duration_milliseconds_bucket{${SEL}}[${WINDOW}])))`,
} satisfies Record<keyof ImplStats, string>;

async function byImpl(expr: string): Promise<Partial<Record<Impl, number>>> {
  const url = new URL(`${config.prometheusUrl}/api/v1/query`);
  url.searchParams.set('query', expr);
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Prometheus returned ${res.status}`);
  const body = (await res.json()) as { data?: { result?: { metric: { lab_impl?: string }; value: [number, string] }[] } };
  const out: Partial<Record<Impl, number>> = {};
  for (const r of body.data?.result ?? []) {
    const v = Number(r.value[1]);
    if ((IMPLS as readonly string[]).includes(r.metric.lab_impl ?? '') && Number.isFinite(v)) out[r.metric.lab_impl as Impl] = v;
  }
  return out;
}

let cached: { at: number; value: Promise<LabStats> } | undefined;

export function getLabStats(): Promise<LabStats> {
  if (cached && Date.now() - cached.at < 10_000) return cached.value;
  const value = (async () => {
    const keys = Object.keys(QUERIES) as (keyof ImplStats)[];
    const results = await Promise.all(keys.map((k) => byImpl(QUERIES[k])));
    const impls = Object.fromEntries(
      IMPLS.map((impl) => [impl, Object.fromEntries(keys.map((k, i) => [k, round(results[i]![impl])]))]),
    ) as Record<Impl, ImplStats>;
    return { window: WINDOW, at: new Date().toISOString(), impls };
  })();
  cached = { at: Date.now(), value };
  // A failed query is not cached, so the next visitor tries again.
  value.catch(() => { if (cached?.value === value) cached = undefined; });
  return value;
}

const round = (v: number | undefined) => (v === undefined ? null : Math.round(v * 100) / 100);
