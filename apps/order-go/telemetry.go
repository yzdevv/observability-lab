package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/instrumentation/runtime"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/log/global"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("observability-lab")

// setupTelemetry configures the global tracer, meter and logger providers. Service name, endpoint,
// export interval and resource attributes come from the standard OTEL_* environment variables, as
// in the Node services.
func setupTelemetry(ctx context.Context) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	if os.Getenv("OTEL_SDK_DISABLED") == "true" {
		return noop, nil
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(attribute.String("lab.impl", impl)))
	if err != nil {
		return noop, err
	}
	var shutdowns []func(context.Context) error
	shutdown := func(ctx context.Context) error {
		var errs []error
		for i := len(shutdowns) - 1; i >= 0; i-- {
			errs = append(errs, shutdowns[i](ctx))
		}
		return errors.Join(errs...)
	}

	traceExporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return noop, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(traceExporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	shutdowns = append(shutdowns, tp.Shutdown)

	if os.Getenv("OTEL_METRICS_EXPORTER") != "none" {
		metricExporter, err := otlpmetrichttp.New(ctx)
		if err != nil {
			return shutdown, err
		}
		// The periodic reader honours OTEL_METRIC_EXPORT_INTERVAL.
		mp := sdkmetric.NewMeterProvider(sdkmetric.WithReader(sdkmetric.NewPeriodicReader(metricExporter)),
			sdkmetric.WithResource(res))
		otel.SetMeterProvider(mp)
		shutdowns = append(shutdowns, mp.Shutdown)
		// Goroutines, heap, GC: the Go runtime numbers next to Node's event loop and heap.
		if err := runtime.Start(runtime.WithMinimumReadMemStatsInterval(5 * time.Second)); err != nil {
			return shutdown, err
		}
		if err := registerCgroupMetrics(); err != nil {
			return shutdown, err
		}
	}

	if os.Getenv("OTEL_LOGS_EXPORTER") != "none" {
		logExporter, err := otlploghttp.New(ctx)
		if err != nil {
			return shutdown, err
		}
		lp := sdklog.NewLoggerProvider(sdklog.WithProcessor(sdklog.NewBatchProcessor(logExporter)),
			sdklog.WithResource(res))
		global.SetLoggerProvider(lp)
		shutdowns = append(shutdowns, lp.Shutdown)
	}
	return shutdown, nil
}

// withSpan runs fn inside a new span. Server errors mark the span as failed; client errors
// (httpError with a 4xx status) are recorded as an attribute only, as in the Node services.
func withSpan[T any](ctx context.Context, name string, fn func(context.Context, trace.Span) (T, error),
	opts ...trace.SpanStartOption) (T, error) {
	ctx, span := tracer.Start(ctx, name, opts...)
	defer span.End()
	v, err := fn(ctx, span)
	if err != nil {
		var he *httpError
		if errors.As(err, &he) && he.status < 500 {
			span.SetAttributes(attribute.Int("lab.client_error", he.status))
		} else {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
	}
	return v, err
}

// redisTracingHook creates a client span per Redis command, but only inside an existing trace:
// the worker's blocking XREADGROUP poll would otherwise start a new trace every 5 seconds.
type redisTracingHook struct{ addr string }

func (redisTracingHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h redisTracingHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if !trace.SpanContextFromContext(ctx).IsValid() {
			return next(ctx, cmd)
		}
		ctx, span := tracer.Start(ctx, cmd.Name(),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				attribute.String("db.system.name", "redis"),
				attribute.String("db.operation.name", cmd.Name()),
				attribute.String("server.address", h.addr),
			))
		defer span.End()
		err := next(ctx, cmd)
		if err != nil && !errors.Is(err, redis.Nil) {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}
		return err
	}
}

func (redisTracingHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}

// fanoutHandler writes each record to several handlers: JSON on stdout and OTLP to Loki.
type fanoutHandler []slog.Handler

func (f fanoutHandler) Enabled(ctx context.Context, l slog.Level) bool {
	for _, h := range f {
		if h.Enabled(ctx, l) {
			return true
		}
	}
	return false
}

func (f fanoutHandler) Handle(ctx context.Context, r slog.Record) error {
	var errs []error
	for _, h := range f {
		if h.Enabled(ctx, r.Level) {
			errs = append(errs, h.Handle(ctx, r.Clone()))
		}
	}
	return errors.Join(errs...)
}

func (f fanoutHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	out := make(fanoutHandler, len(f))
	for i, h := range f {
		out[i] = h.WithAttrs(attrs)
	}
	return out
}

func (f fanoutHandler) WithGroup(name string) slog.Handler {
	out := make(fanoutHandler, len(f))
	for i, h := range f {
		out[i] = h.WithGroup(name)
	}
	return out
}

// traceLogHandler adds trace_id and span_id to every log record written with a traced context,
// so logs can be joined to traces.
type traceLogHandler struct{ slog.Handler }

func (h traceLogHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceLogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return traceLogHandler{h.Handler.WithAttrs(attrs)}
}

func (h traceLogHandler) WithGroup(name string) slog.Handler {
	return traceLogHandler{h.Handler.WithGroup(name)}
}
