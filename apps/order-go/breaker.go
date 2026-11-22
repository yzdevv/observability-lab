package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// circuitBreaker protects the order API from a slow dependency (docs/API-CONTRACT.md, same rules as
// the Node implementation): after `threshold` consecutive failures it opens and rejects calls
// at once for `openFor`; then one probe call is let through (half-open). A successful probe closes
// it, a failed one opens it again.

type breakerState int

const (
	stateClosed breakerState = iota
	stateHalfOpen
	stateOpen
)

func (s breakerState) String() string {
	return [...]string{"closed", "half-open", "open"}[s]
}

var errCircuitOpen = errors.New("circuit open")

type circuitBreaker struct {
	name      string
	enabled   bool
	threshold int
	openFor   time.Duration

	mu       sync.Mutex
	state    breakerState
	failures int
	openedAt time.Time
	probing  bool

	transitions metric.Int64Counter
}

func newCircuitBreaker(name string, cfg Config) *circuitBreaker {
	b := &circuitBreaker{name: name, enabled: cfg.BreakerEnabled, threshold: cfg.BreakerFailures, openFor: cfg.BreakerOpen}
	m := otel.Meter("observability-lab/breaker")
	b.transitions, _ = m.Int64Counter("lab.breaker.transitions", metric.WithDescription("Circuit breaker state changes"))
	gauge, _ := m.Int64ObservableGauge("lab.breaker.state",
		metric.WithDescription("Circuit breaker state: 0 closed, 1 half-open, 2 open"))
	_, _ = m.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		o.ObserveInt64(gauge, int64(b.State()), metric.WithAttributes(attribute.String("lab.dependency", name)))
		return nil
	}, gauge)
	return b
}

// State reports the current state; an open breaker whose wait is over reads as half-open.
func (b *circuitBreaker) State() breakerState {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == stateOpen && time.Since(b.openedAt) >= b.openFor {
		return stateHalfOpen
	}
	return b.state
}

func (b *circuitBreaker) setState(ctx context.Context, to breakerState) {
	if b.state == to {
		return
	}
	from := b.state
	b.state = to
	if to == stateOpen {
		b.openedAt = time.Now()
	}
	b.transitions.Add(ctx, 1, metric.WithAttributes(attribute.String("lab.dependency", b.name),
		attribute.String("from", from.String()), attribute.String("to", to.String())))
	slog.WarnContext(ctx, "circuit breaker "+to.String(), "dependency", b.name, "from", from.String(),
		"failures", b.failures)
}

// allow decides whether a call may go ahead; probe is true for the single half-open trial call.
func (b *circuitBreaker) allow(ctx context.Context) (probe bool, err error) {
	if !b.enabled {
		return false, nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.state {
	case stateClosed:
		return false, nil
	case stateOpen:
		if time.Since(b.openedAt) < b.openFor {
			return false, errCircuitOpen
		}
		b.setState(ctx, stateHalfOpen)
		fallthrough
	default: // half-open: one probe at a time
		if b.probing {
			return false, errCircuitOpen
		}
		b.probing = true
		return true, nil
	}
}

func (b *circuitBreaker) record(ctx context.Context, probe bool, failed bool) {
	if !b.enabled {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if probe {
		b.probing = false
	}
	if !failed {
		b.failures = 0
		b.setState(ctx, stateClosed)
		return
	}
	b.failures++
	if probe || b.failures >= b.threshold {
		b.setState(ctx, stateOpen)
	}
}
