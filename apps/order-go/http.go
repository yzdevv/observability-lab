package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

const maxBodyBytes = 4096

var logEveryRequest = os.Getenv("LOG_REQUESTS") == "true"

func runAPI(ctx context.Context, s *Service) error {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders", s.handleCreateOrder)
	mux.HandleFunc("GET /orders/{id}", s.handleGetOrder)
	mux.HandleFunc("GET /healthz", s.handleHealth)

	srv := &http.Server{
		Addr: ":" + s.cfg.Port,
		Handler: otelhttp.NewHandler(logRequests(mux), "http.server",
			// Health checks run every few seconds; tracing them would bury the interesting traces.
			otelhttp.WithFilter(func(r *http.Request) bool { return r.URL.Path != "/healthz" })),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "port", s.cfg.Port)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (s *Service) handleCreateOrder(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	var in createOrderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, r, &httpError{status: 413, msg: "request body too large"})
			return
		}
		writeError(w, r, badRequest("body must be a JSON object with productId, quantity (integer) and scenario"))
		return
	}
	_, err := withSpan(r.Context(), "order.validate", func(context.Context, trace.Span) (struct{}, error) {
		return struct{}{}, in.validate()
	})
	if err != nil {
		writeError(w, r, err)
		return
	}
	span := trace.SpanFromContext(r.Context())
	span.SetAttributes(attribute.String("lab.impl", impl), attribute.String("lab.scenario", in.Scenario))
	res, err := s.createOrder(r.Context(), in)
	if err != nil {
		writeError(w, r, err)
		return
	}
	span.SetAttributes(attribute.String("order.id", res.OrderID))
	writeJSON(w, http.StatusAccepted, res)
}

func (s *Service) handleGetOrder(w http.ResponseWriter, r *http.Request) {
	o, err := s.getOrder(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, o)
}

func (s *Service) handleHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "impl": impl})
		return
	}
	if err := s.rdb.Ping(ctx).Err(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "impl": impl})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "impl": impl})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var he *httpError
	if errors.As(err, &he) {
		body := map[string]string{"error": he.msg}
		if he.reason != "" {
			body["reason"] = he.reason
		}
		writeJSON(w, he.status, body)
		return
	}
	slog.ErrorContext(r.Context(), "unhandled error", "method", r.Method, "path", r.URL.Path, "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// logRequests logs each request, returns the trace id to the client, and names the server span
// after the matched route (r.Pattern is set by ServeMux while routing).
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		span := trace.SpanFromContext(r.Context())
		if sc := span.SpanContext(); sc.IsValid() {
			w.Header().Set("X-Trace-Id", sc.TraceID().String())
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if r.Pattern != "" {
			span.SetName(r.Pattern)
			if _, route, ok := strings.Cut(r.Pattern, " "); ok {
				span.SetAttributes(attribute.String("http.route", route))
			}
		}
		// Per-request access logs repeat what traces and span metrics already record and cost CPU;
		// off unless LOG_REQUESTS=true. Server errors are logged in writeError either way.
		if r.URL.Path == "/healthz" || !logEveryRequest {
			return
		}
		slog.InfoContext(r.Context(), "request completed",
			"method", r.Method, "path", r.URL.Path, "status", rec.status,
			"durationMs", float64(time.Since(start).Microseconds())/1000)
	})
}

// healthcheck is used by the container HEALTHCHECK (the image has no shell or curl).
func healthcheck() int {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + envOr("PORT", "8082") + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	_ = os.Stdout.Sync()
	return 0
}
