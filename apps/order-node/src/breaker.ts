// Circuit breaker for the payment dependency (same rules as the Go implementation): after
// `threshold` consecutive failures it opens and rejects calls at once for `openMs`; then one probe
// call is let through (half-open). A successful probe closes it, a failed one opens it again.
import { metrics } from '@opentelemetry/api';

export type BreakerState = 'closed' | 'half-open' | 'open';
const STATE_VALUE: Record<BreakerState, number> = { closed: 0, 'half-open': 1, open: 2 };

export class CircuitOpenError extends Error {}

type Options = { enabled: boolean; threshold: number; openMs: number };
type Logger = (msg: string, extra: Record<string, unknown>) => void;

const meter = metrics.getMeter('observability-lab/breaker');
const transitions = meter.createCounter('lab.breaker.transitions', { description: 'Circuit breaker state changes' });
const stateGauge = meter.createObservableGauge('lab.breaker.state', {
  description: 'Circuit breaker state: 0 closed, 1 half-open, 2 open',
});

export class CircuitBreaker {
  #state: BreakerState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #probing = false;

  readonly name: string;
  private readonly opts: Options;
  private readonly log: Logger;

  constructor(name: string, opts: Options, log: Logger) {
    this.name = name;
    this.opts = opts;
    this.log = log;
    stateGauge.addCallback((r) => r.observe(STATE_VALUE[this.state], { 'lab.dependency': name }));
  }

  /** Current state; an open breaker whose wait is over reads as half-open. */
  get state(): BreakerState {
    if (this.#state === 'open' && Date.now() - this.#openedAt >= this.opts.openMs) return 'half-open';
    return this.#state;
  }

  #set(to: BreakerState) {
    if (this.#state === to) return;
    const from = this.#state;
    this.#state = to;
    if (to === 'open') this.#openedAt = Date.now();
    transitions.add(1, { 'lab.dependency': this.name, from, to });
    this.log(`circuit breaker ${to}`, { dependency: this.name, from, failures: this.#failures });
  }

  /** Throws CircuitOpenError, or returns whether this call is the half-open probe. */
  allow(): { probe: boolean } {
    if (!this.opts.enabled || this.#state === 'closed') return { probe: false };
    if (this.#state === 'open') {
      if (Date.now() - this.#openedAt < this.opts.openMs) throw new CircuitOpenError('circuit open');
      this.#set('half-open');
    }
    if (this.#probing) throw new CircuitOpenError('circuit half-open, probe in flight');
    this.#probing = true;
    return { probe: true };
  }

  record(probe: boolean, failed: boolean): void {
    if (!this.opts.enabled) return;
    if (probe) this.#probing = false;
    if (!failed) {
      this.#failures = 0;
      this.#set('closed');
      return;
    }
    this.#failures++;
    if (probe || this.#failures >= this.opts.threshold) this.#set('open');
  }
}

