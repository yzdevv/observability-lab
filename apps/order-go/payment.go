package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// --- client: the order API authorises every order with the (fake) payment provider -------------

type paymentClient struct {
	baseURL  string
	timeout  time.Duration
	http     *http.Client
	breakers map[string]*circuitBreaker
}

func newPaymentClient(cfg Config) *paymentClient {
	return &paymentClient{
		baseURL: cfg.PaymentURL,
		timeout: cfg.DependencyTimeout,
		// otelhttp traces the call and carries traceparent to the provider.
		http: &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport)},
		// One breaker per endpoint: the dependency-timeout scenario uses the degraded endpoint, so
		// one visitor's failures cannot open the breaker for everyone else's orders.
		breakers: map[string]*circuitBreaker{
			"payment":          newCircuitBreaker("payment", cfg),
			"payment-degraded": newCircuitBreaker("payment-degraded", cfg),
		},
	}
}

func (c *paymentClient) authorize(ctx context.Context, scenario string) error {
	dep, path := "payment", "/authorize"
	if scenario == "dependency-timeout" {
		dep, path = "payment-degraded", "/degraded/authorize"
	}
	b := c.breakers[dep]
	_, err := withSpan(ctx, "payment.authorize", func(ctx context.Context, span trace.Span) (struct{}, error) {
		span.SetAttributes(attribute.String("lab.dependency", dep), attribute.String("lab.breaker.state", b.State().String()))
		probe, err := b.allow(ctx)
		if err != nil {
			span.SetAttributes(attribute.Bool("lab.breaker.rejected", true))
			return struct{}{}, &httpError{status: 503, msg: "payment provider unavailable (circuit open)", reason: "circuit-open"}
		}
		span.SetAttributes(attribute.Bool("lab.breaker.probe", probe))
		callErr := c.call(ctx, path)
		b.record(ctx, probe, callErr != nil)
		if callErr == nil {
			return struct{}{}, nil
		}
		if errors.Is(callErr, context.DeadlineExceeded) {
			return struct{}{}, &httpError{status: 504, msg: "payment provider timed out", reason: "dependency-timeout"}
		}
		return struct{}{}, fmt.Errorf("payment: %w", callErr)
	})
	return err
}

func (c *paymentClient) call(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return context.DeadlineExceeded
		}
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", res.StatusCode)
	}
	return nil
}

// --- server: MODE=payment runs a fake payment provider ------------------------------------------

// runFakePayment serves /authorize (healthy, a few ms) and /degraded/authorize, which has a
// scheduled outage: for the first DEGRADED_OUTAGE_S seconds of every DEGRADED_CYCLE_S it hangs for
// DEGRADED_DELAY_MS, then answers normally again. The schedule makes the circuit breaker's
// open → half-open → closed cycle visible without anyone flipping a switch.
func runFakePayment(ctx context.Context, cfg Config) error {
	mux := http.NewServeMux()
	healthy := func(w http.ResponseWriter, r *http.Request) {
		wait(r.Context(), cfg.PaymentLatency+time.Duration(rand.Int64N(int64(cfg.PaymentLatency)+1)))
		writeJSON(w, http.StatusOK, map[string]any{"authorized": true})
	}
	mux.HandleFunc("POST /authorize", healthy)
	mux.HandleFunc("POST /degraded/authorize", func(w http.ResponseWriter, r *http.Request) {
		inOutage, remaining := degradedOutage(cfg, time.Now())
		trace.SpanFromContext(r.Context()).SetAttributes(attribute.Bool("lab.payment.outage", inOutage))
		if inOutage {
			slog.WarnContext(r.Context(), "degraded provider in outage, hanging", "delayMs", cfg.DegradedDelay.Milliseconds(),
				"outageLeftS", int(remaining.Seconds()))
			wait(r.Context(), cfg.DegradedDelay)
		}
		healthy(w, r)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		inOutage, remaining := degradedOutage(cfg, time.Now())
		writeJSON(w, http.StatusOK, map[string]any{"degradedOutage": inOutage, "changesInS": int(remaining.Seconds())})
	})

	srv := &http.Server{
		Addr: ":" + cfg.Port,
		Handler: otelhttp.NewHandler(mux, "http.server",
			otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/healthz" }),
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				return r.Method + " " + strings.TrimSuffix(r.URL.Path, "/")
			})),
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("fake payment provider listening", "port", cfg.Port)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// degradedOutage reports whether the degraded endpoint is in its outage window, and how long until
// that changes.
func degradedOutage(cfg Config, now time.Time) (bool, time.Duration) {
	if cfg.DegradedCycle <= 0 {
		return true, 0
	}
	pos := time.Duration(now.UnixNano() % int64(cfg.DegradedCycle))
	if pos < cfg.DegradedOutage {
		return true, cfg.DegradedOutage - pos
	}
	return false, cfg.DegradedCycle - pos
}

// wait sleeps, but stops early when the caller gives up (the order API's timeout).
func wait(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
