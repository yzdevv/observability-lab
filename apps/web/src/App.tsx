import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getRecorded, getStats, getStatus, isLive, replay, sendOrder,
  type Impl, type LabStats, type LabStatus, type Run, type Scenario,
} from './api.ts';
import { AUTHOR_URL, FINDINGS, IMPL_LABEL, REPO_URL, SCENARIOS } from './content.ts';
import { describe, ms, summarise } from './trace.ts';
import { Waterfall } from './Waterfall.tsx';

type Mode = 'checking' | 'live' | 'recorded';
type Choice = Impl | 'both';

export function App() {
  const [mode, setMode] = useState<Mode>('checking');
  const [choice, setChoice] = useState<Choice>('node');
  const [scenario, setScenario] = useState<Scenario>('none');
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [recordedAt, setRecordedAt] = useState<string>();
  const resultsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void isLive().then((live) => setMode(live ? 'live' : 'recorded'));
  }, []);
  useEffect(() => {
    if (mode === 'recorded') void getRecorded().then((r) => setRecordedAt(r.recordedAt)).catch(() => {});
  }, [mode]);

  const send = useCallback(async () => {
    const impls: Impl[] = choice === 'both' ? ['node', 'go'] : [choice];
    setBusy(true);
    setRuns(impls.map((impl) => ({ impl, scenario, status: -1, responseMs: 0, body: {} })));
    resultsRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    const update = (i: number) => (run: Run) => setRuns((prev) => prev.map((r, j) => (j === i ? run : r)));
    await Promise.all(
      impls.map(async (impl, i) => {
        if (mode === 'live') return sendOrder(impl, scenario, update(i));
        try {
          update(i)(await replay(impl, scenario));
        } catch {
          update(i)({ impl, scenario, status: 0, responseMs: 0, body: { error: 'The recorded runs could not be loaded.' } });
        }
      }),
    );
    setBusy(false);
  }, [choice, scenario, mode]);

  const picked = SCENARIOS.find((s) => s.id === scenario)!;

  return (
    <>
      <header className="top">
        <div className="wrap">
          <p className="brand">Observability Lab</p>
          <LiveBadge mode={mode} recordedAt={recordedAt} />
        </div>
      </header>

      <main>
        <section className="intro wrap">
          <h1>Send an order and watch where every millisecond goes.</h1>
          <p className="lede">
            A small shop backend, built twice: once in Node.js, once in Go. Each order passes a gateway,
            an order API, a cache, Postgres, a payment provider and a queue to a background worker.
            Every step is traced with OpenTelemetry, and the trace of your own order appears below.
          </p>
        </section>

        <section className="console wrap" aria-labelledby="console-title">
          <h2 id="console-title" className="visually-hidden">Send an order</h2>
          <fieldset className="impls">
            <legend>Implementation</legend>
            {(['node', 'go', 'both'] as Choice[]).map((c) => (
              <label key={c} className={`chip chip-${c}`}>
                <input type="radio" name="impl" value={c} checked={choice === c} onChange={() => setChoice(c)} />
                <span>{c === 'both' ? 'Both, side by side' : IMPL_LABEL[c]}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="scenarios">
            <legend>Scenario</legend>
            <div className="scenario-list">
              {SCENARIOS.map((s) => (
                <label key={s.id} className="scenario">
                  <input type="radio" name="scenario" value={s.id} checked={scenario === s.id} onChange={() => setScenario(s.id)} />
                  <span className="scenario-name">{s.label}</span>
                </label>
              ))}
            </div>
            <p className="scenario-what">{picked.what}</p>
          </fieldset>

          <div className="send-row">
            <button
              type="button"
              className="send"
              onClick={() => void send()}
              disabled={busy || mode === 'checking'}
              data-jejak-event="send_order"
              data-jejak-prop-impl={choice}
              data-jejak-prop-scenario={scenario}
              data-jejak-prop-mode={mode}
            >
              {busy ? 'Sending…' : choice === 'both' ? 'Send to both' : `Send to ${IMPL_LABEL[choice]}`}
            </button>
            <p className="send-note">
              {mode === 'recorded'
                ? 'The live lab is offline, so this replays a recorded order.'
                : 'Orders are rate-limited per visitor, so the lab stays up for everyone.'}
            </p>
          </div>
        </section>

        <section ref={resultsRef} className="results wrap" aria-live="polite" aria-busy={busy}>
          {runs.length === 0 ? (
            <p className="empty">Pick a scenario and send an order. Its trace appears here.</p>
          ) : (
            <>
              {runs.length === 2 && <Comparison runs={runs} />}
              {runs.map((run) => <RunResult key={run.impl} run={run} look={picked.look} />)}
            </>
          )}
        </section>

        {mode === 'live' && <LiveNumbers />}

        <section className="findings wrap" aria-labelledby="findings-title">
          <h2 id="findings-title">What the load tests showed</h2>
          <p className="section-lede">
            Seven experiments with k6, both implementations under the same CPU and memory limits.
            The first six ran on a MacBook, the queue test on this server; the full write-up has the
            method, the raw data and the caveats.
          </p>
          <div className="finding-grid">
            {FINDINGS.map((f) => (
              <article key={f.title} className="finding">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </article>
            ))}
          </div>
          <p><a href={`${REPO_URL}/blob/main/docs/EXPERIMENTS.md`}>Read the experiment write-up</a></p>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap">
          <p>
            Synthetic orders only; nothing you send is personal or real. Source code and design notes
            are on <a href={REPO_URL}>GitHub</a>. More of my work: <a href={AUTHOR_URL}>dev.mge.my.id</a>.
          </p>
        </div>
      </footer>
    </>
  );
}

function LiveBadge({ mode, recordedAt }: { mode: Mode; recordedAt?: string }) {
  const [status, setStatus] = useState<LabStatus>();
  useEffect(() => {
    if (mode !== 'live') return;
    const tick = () => void getStatus().then(setStatus).catch(() => setStatus(undefined));
    tick();
    const id = setInterval(() => document.visibilityState === 'visible' && tick(), 15_000);
    return () => clearInterval(id);
  }, [mode]);

  if (mode === 'checking') return <p className="badge">Checking the lab…</p>;
  if (mode === 'recorded') {
    return (
      <p className="badge badge-off">
        Offline: showing recorded runs{recordedAt ? ` from ${new Date(recordedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
      </p>
    );
  }
  const busy = status && (status.load1 > status.limits.maxLoad1 * 0.8 || status.inflight > status.limits.maxInflight * 0.8);
  return (
    <p className={`badge ${busy ? 'badge-busy' : 'badge-live'}`}>
      {busy ? 'Live, but busy' : 'Live'}
      {status && <span className="badge-detail"> · server load {status.load1.toFixed(1)} of {status.limits.maxLoad1}</span>}
    </p>
  );
}

function headline(run: Run): string {
  const t = ms(run.responseMs);
  if (run.status === -1) return 'Sending…';
  if (run.status === 0) return run.body.error ?? 'The lab did not answer.';
  if (run.status === 202) {
    const o = run.order;
    if (!o || o.status === 'queued' || o.status === 'processing') return `Accepted in ${t}. Waiting for the worker…`;
    return o.status === 'completed'
      ? `Accepted in ${t}. The worker completed it${o.attempts > 1 ? ` on attempt ${o.attempts}` : ''}.`
      : `Accepted in ${t}, but the worker gave up after ${o.attempts} attempts.`;
  }
  if (run.status === 429) return `You have reached the limit of orders per minute for one visitor. Try again in ${run.body.retryAfter ?? 60} s.`;
  switch (run.body.reason) {
    case 'dependency-timeout': return `504 after ${t}: the payment provider did not answer within 500 ms. No order was created.`;
    case 'circuit-open': return `503 in ${t}: the circuit breaker is open, so the payment call was not even tried. No order was created.`;
    case 'inflight':
    case 'host-load':
    case 'backlog': return 'The lab is busy right now and turned the order away to protect the server. Try again in a few seconds.';
  }
  return `${run.status} in ${t}: ${run.body.error ?? 'the order was not accepted'}.`;
}

function RunResult({ run, look }: { run: Run; look: string }) {
  const summary = run.spans ? summarise(run.spans) : undefined;
  const waitingForTrace = !run.spans && !run.traceError && run.status > 0 && run.traceId && run.status !== 429;
  return (
    <article className={`run run-${run.impl}`}>
      <header className="run-head">
        <h2 className="run-impl">{IMPL_LABEL[run.impl]}</h2>
        <p className="run-headline">{headline(run)}</p>
      </header>
      {summary && (
        <p className="insight">
          {summary.hottest && summary.hottest.share > 0.2 && (
            <>The gateway answered in {ms(summary.responseMs)}; {Math.round(summary.hottest.share * 100)}% of that was {describe(summary.hottest.span)} ({ms(summary.hottest.ms)}). </>
          )}
          {summary.worker && (
            <>The worker finished {ms(summary.worker.doneAfterMs)} after the request arrived{summary.worker.attempts > 1 ? `, after ${summary.worker.attempts} attempts` : ''}.</>
          )}
        </p>
      )}
      {waitingForTrace && <p className="pending">Collecting the trace. Spans take a few seconds to reach the trace store…</p>}
      {run.traceError && <p className="pending">{run.traceError}</p>}
      {run.spans && run.spans.length > 0 && (
        <>
          <Waterfall spans={run.spans} hottestId={summary?.hottest?.span.spanId} />
          <p className="look"><strong>What to look for:</strong> {look} Select a row to see its details.</p>
          {run.recordedAt && <p className="recorded-note">Recorded {new Date(run.recordedAt).toLocaleString()}.</p>}
        </>
      )}
    </article>
  );
}

function Comparison({ runs }: { runs: Run[] }) {
  const done = runs.every((r) => r.spans);
  if (!done) return null;
  const times = runs.map((r) => ({ impl: r.impl, ms: summarise(r.spans!)?.responseMs ?? r.responseMs }));
  const [fast, slow] = [...times].sort((a, b) => a.ms - b.ms) as [typeof times[0], typeof times[0]];
  const close = slow.ms - fast.ms < Math.max(2, fast.ms * 0.15);
  return (
    <p className="comparison">
      {close
        ? `Both answered in about the same time: ${IMPL_LABEL[fast.impl]} ${ms(fast.ms)}, ${IMPL_LABEL[slow.impl]} ${ms(slow.ms)}. One request says little; the load tests below compare them properly.`
        : `${IMPL_LABEL[fast.impl]} answered in ${ms(fast.ms)}, ${IMPL_LABEL[slow.impl]} in ${ms(slow.ms)}, measured at the gateway. One request is noisy; the load tests below compare them properly.`}
    </p>
  );
}

function LiveNumbers() {
  const [stats, setStats] = useState<LabStats>();
  const [status, setStatus] = useState<LabStatus>();
  useEffect(() => {
    const tick = () => {
      void getStats().then(setStats).catch(() => {});
      void getStatus().then(setStatus).catch(() => {});
    };
    tick();
    const id = setInterval(() => document.visibilityState === 'visible' && tick(), 30_000);
    return () => clearInterval(id);
  }, []);
  const num = (v: number | null | undefined, unit: string, digits = 0) => (v === null || v === undefined ? '–' : `${v.toFixed(digits)}${unit}`);
  return (
    <section className="live wrap" aria-labelledby="live-title">
      <h2 id="live-title">Right now</h2>
      <p className="section-lede">Every order sent in the last 5 minutes, by everyone, from the span metrics in Prometheus.</p>
      <table className="live-table">
        <thead>
          <tr><th scope="col">Implementation</th><th scope="col">Orders/s</th><th scope="col">Not accepted</th><th scope="col">Median</th><th scope="col">p95</th></tr>
        </thead>
        <tbody>
          {(['node', 'go'] as Impl[]).map((impl) => {
            const s = stats?.impls[impl];
            return (
              <tr key={impl} className={`row-${impl}`}>
                <th scope="row">{IMPL_LABEL[impl]}</th>
                <td>{num(s?.rps, '', 2)}</td>
                <td>{num(s?.errorPct, '%')}</td>
                <td>{num(s?.p50Ms, ' ms', 1)}</td>
                <td>{num(s?.p95Ms, ' ms', 1)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {status && (
        <p className="guards">
          The gateway protects the server: it turns orders away when more than {status.limits.maxInflight} are in flight
          (now {status.inflight}), when the server load passes {status.limits.maxLoad1} (now {status.load1.toFixed(1)}), or when
          a queue holds more than {status.limits.maxBacklog} orders (now {status.backlog.node} for Node.js, {status.backlog.go} for Go).
        </p>
      )}
    </section>
  );
}
