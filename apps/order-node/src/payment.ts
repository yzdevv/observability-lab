// Every order is authorised with the (fake) payment provider before it is stored. The call has a
// timeout and a circuit breaker; see docs/API-CONTRACT.md (same behaviour as the Go service).
import { withSpan } from '@lab/telemetry';
import { CircuitBreaker, CircuitOpenError } from './breaker.ts';
import { config } from './config.ts';
import { HttpError } from './orders.ts';

type Logger = (msg: string, extra: Record<string, unknown>) => void;

export function createPaymentClient(log: Logger) {
  const opts = { enabled: config.breakerEnabled, threshold: config.breakerFailures, openMs: config.breakerOpenMs };
  // One breaker per endpoint: the dependency-timeout scenario uses the degraded endpoint, so one
  // visitor's failures cannot open the breaker for everyone else's orders.
  const breakers = {
    payment: new CircuitBreaker('payment', opts, log),
    'payment-degraded': new CircuitBreaker('payment-degraded', opts, log),
  };

  return async function authorize(scenario: string): Promise<void> {
    const degraded = scenario === 'dependency-timeout';
    const dep = degraded ? 'payment-degraded' : 'payment';
    const breaker = breakers[dep];
    await withSpan('payment.authorize', { attributes: { 'lab.dependency': dep, 'lab.breaker.state': breaker.state } }, async (span) => {
      let probe: boolean;
      try {
        ({ probe } = breaker.allow());
      } catch (err) {
        if (!(err instanceof CircuitOpenError)) throw err;
        span.setAttribute('lab.breaker.rejected', true);
        throw new HttpError(503, 'payment provider unavailable (circuit open)', 'circuit-open');
      }
      span.setAttribute('lab.breaker.probe', probe);
      try {
        const res = await fetch(`${config.paymentUrl}${degraded ? '/degraded/authorize' : '/authorize'}`, {
          method: 'POST',
          signal: AbortSignal.timeout(config.dependencyTimeoutMs),
        });
        await res.arrayBuffer();
        if (!res.ok) throw new Error(`status ${res.status}`);
        breaker.record(probe, false);
      } catch (err) {
        breaker.record(probe, true);
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new HttpError(504, 'payment provider timed out', 'dependency-timeout');
        }
        throw new Error(`payment: ${(err as Error).message}`);
      }
    });
  };
}
