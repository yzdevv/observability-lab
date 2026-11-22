import { useMemo, useState, type CSSProperties } from 'react';
import type { Span } from './api.ts';
import { SERVICE_LABEL, describe, detail, family, isPlumbing, ms, rootOf, treeRows } from './trace.ts';

type Props = { spans: Span[]; hottestId?: string };

/** One trace as a timeline: a row per span, indented by parent, on a shared time axis. */
export function Waterfall({ spans, hottestId }: Props) {
  const [open, setOpen] = useState<string | undefined>();
  const [showAll, setShowAll] = useState(false);
  const hidden = spans.filter((s) => isPlumbing(s) && s.spanId !== hottestId).length;
  const { rows, t0, total, responseAt, ticks } = useMemo(() => {
    const shown = showAll ? spans : spans.filter((s) => !isPlumbing(s) || s.spanId === hottestId);
    const rows = treeRows(shown, spans);
    const t0 = Math.min(...spans.map((s) => s.startMs));
    const t1 = Math.max(...spans.map((s) => s.startMs + s.durationMs));
    const total = Math.max(t1 - t0, 0.001);
    const root = rootOf(spans);
    const responseAt = root ? ((root.startMs + root.durationMs - t0) / total) * 100 : undefined;
    return { rows, t0, total, responseAt, ticks: niceTicks(total) };
  }, [spans, showAll, hottestId]);

  const pos = (s: Span) => {
    const left = ((s.startMs - t0) / total) * 100;
    return { left: `${left}%`, width: `max(2px, ${(s.durationMs / total) * 100}%)`, labelLeft: left > 62 };
  };

  return (
    <div className="wf-wrap">
    <div className="wf" role="table" aria-label="Trace timeline">
      {responseAt !== undefined && responseAt < 97 && (
        // Same grid as the rows, so the marker lines up with the bars.
        <div className="wf-overlay" aria-hidden="true">
          <span />
          <span className="wf-overlay-track">
            <span className={`wf-marker${responseAt > 70 ? ' to-left' : ''}`} style={{ left: `${responseAt}%` }}>
              <span>response sent</span>
            </span>
          </span>
        </div>
      )}
      <div className="wf-axis" role="row" aria-hidden="true">
        <span className="wf-axis-label" />
        <span className="wf-axis-track">
          {ticks.map((t) => (
            <span key={t} className="wf-tick" style={{ left: `${(t / total) * 100}%` }}>{ms(t)}</span>
          ))}
        </span>
      </div>
      <div className="wf-body">
        {rows.map(({ span, depth, afterResponse }) => {
          const p = pos(span);
          const isOpen = open === span.spanId;
          const sub = detail(span);
          return (
            <div key={span.spanId} className="wf-row-wrap" role="row">
              <button
                type="button"
                className={`wf-row fam-${family(span.service)}${span.error ? ' is-error' : ''}${span.spanId === hottestId ? ' is-hot' : ''}${afterResponse ? ' is-after' : ''}`}
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? undefined : span.spanId)}
              >
                <span className="wf-label" role="cell" style={{ '--depth': depth } as CSSProperties}>
                  <span className="wf-name">{span.name}</span>
                  <span className="wf-sub">{sub ?? SERVICE_LABEL[span.service] ?? span.service}</span>
                </span>
                <span className="wf-track" role="cell">
                  <span className="wf-bar" style={{ left: p.left, width: p.width }} />
                  <span className={`wf-dur${p.labelLeft ? ' to-left' : ''}`} style={p.labelLeft ? { right: `calc(${100 - parseFloat(p.left)}% + 6px)` } : { left: `calc(${p.left} + ${(span.durationMs / total) * 100}% + 6px)` }}>
                    {ms(span.durationMs)}
                  </span>
                </span>
              </button>
              {isOpen && <SpanDetails span={span} />}
            </div>
          );
        })}
      </div>
    </div>
    {hidden > 0 && (
      <button type="button" className="wf-toggle" onClick={() => setShowAll(!showAll)} aria-pressed={showAll}>
        {showAll ? 'Show the main steps only' : `Show all ${spans.length} spans, including ${hidden} connection and cache calls`}
      </button>
    )}
    </div>
  );
}

function SpanDetails({ span }: { span: Span }) {
  const entries = Object.entries(span.attributes);
  return (
    <dl className="wf-details">
      <div><dt>Service</dt><dd>{SERVICE_LABEL[span.service] ?? span.service}</dd></div>
      <div><dt>What it is</dt><dd>{describe(span)}</dd></div>
      <div><dt>Kind</dt><dd>{span.kind}</dd></div>
      <div><dt>Duration</dt><dd>{ms(span.durationMs)}</dd></div>
      {span.error && <div><dt>Status</dt><dd className="is-error-text">error</dd></div>}
      {entries.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{String(v)}</dd></div>
      ))}
    </dl>
  );
}

/** Three or four round tick values inside [0, total]. */
function niceTicks(total: number): number[] {
  const raw = total / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let t = 0; t <= total + 1e-9; t += step) ticks.push(t);
  return ticks;
}
