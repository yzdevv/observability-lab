package main

import (
	"context"
	"errors"
	"log/slog"
	"os"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("observability-lab")

// setupTelemetry configures the global tracer provider. Service name, endpoint and resource
// attributes come from the standard OTEL_* environment variables, as in the Node services.
func setupTelemetry(ctx context.Context) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	if os.Getenv("OTEL_SDK_DISABLED") == "true" {
		return noop, nil
	}
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return noop, err
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(attribute.String("lab.impl", impl)))
	if err != nil {
		return noop, err
	}
	tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exporter), sdktrace.WithResource(res))
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown, nil
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
