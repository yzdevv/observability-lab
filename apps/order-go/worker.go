package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func runWorker(ctx context.Context, s *Service) error {
	stream := streamKey()
	if err := s.ensureGroup(ctx, stream); err != nil {
		return fmt.Errorf("create consumer group: %w", err)
	}
	host, _ := os.Hostname()
	consumer := fmt.Sprintf("%s-%d", host, os.Getpid())
	slog.Info("worker started", "consumer", consumer, "stream", stream)

	for ctx.Err() == nil {
		res, err := s.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    consumerGroup,
			Consumer: consumer,
			Streams:  []string{stream, ">"},
			Count:    s.cfg.WorkerBatch,
			Block:    5 * time.Second,
		}).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				break
			}
			slog.Error("read failed", "err", err)
			// Redis keeps no data on disk: after a restart the group is gone, so recreate it.
			if strings.Contains(err.Error(), "NOGROUP") {
				if err := s.ensureGroup(ctx, stream); err == nil {
					continue
				}
			}
			select {
			case <-ctx.Done():
			case <-time.After(time.Second):
			}
			continue
		}

		// Finish the batch even during shutdown; unfinished messages would be redelivered anyway.
		workCtx := context.WithoutCancel(ctx)
		var wg sync.WaitGroup
		for _, st := range res {
			for _, msg := range st.Messages {
				wg.Go(func() { s.processMessage(workCtx, stream, msg) })
			}
		}
		wg.Wait()
	}
	slog.Info("worker stopped")
	return nil
}

func (s *Service) ensureGroup(ctx context.Context, stream string) error {
	err := s.rdb.XGroupCreateMkStream(ctx, stream, consumerGroup, "0").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	return nil
}

func (s *Service) processMessage(ctx context.Context, stream string, msg redis.XMessage) {
	start := time.Now()
	field := func(name string) string { v, _ := msg.Values[name].(string); return v }
	orderID := field("orderId")
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Continue the trace started by the HTTP request that enqueued this order.
	carrier := propagation.MapCarrier{"traceparent": field("traceparent"), "tracestate": field("tracestate")}
	ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)
	attempt := 1
	fmt.Sscan(field("attempt"), &attempt)

	_, err := withSpan(ctx, "order.process", func(ctx context.Context, span trace.Span) (struct{}, error) {
		if orderID == "" {
			return struct{}{}, errors.New("message without orderId")
		}
		// Simulated work, identical in both implementations.
		_, _ = withSpan(ctx, "order.fulfil", func(context.Context, trace.Span) (struct{}, error) {
			time.Sleep(s.cfg.Work)
			return struct{}{}, nil
		}, trace.WithAttributes(attribute.Bool("lab.simulated", true)))

		updated, err := s.completeOrder(ctx, orderID)
		if err != nil {
			return struct{}{}, err
		}
		span.SetAttributes(attribute.Bool("order.updated", updated))
		if err := s.rdb.XAck(ctx, stream, consumerGroup, msg.ID).Err(); err != nil {
			return struct{}{}, fmt.Errorf("ack: %w", err)
		}
		slog.InfoContext(ctx, "order processed", "orderId", orderID, "entryId", msg.ID, "updated", updated,
			"durationMs", time.Since(start).Milliseconds())
		return struct{}{}, nil
	},
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("order.id", orderID),
			attribute.String("lab.impl", impl),
			attribute.String("lab.scenario", field("scenario")),
			attribute.Int("lab.attempt", attempt),
			attribute.String("messaging.system", "redis"),
			attribute.String("messaging.operation.type", "process"),
			attribute.String("messaging.destination.name", stream),
			attribute.String("messaging.message.id", msg.ID),
		))
	if err != nil {
		// Left unacked: stays in the pending list (reclaimed in Milestone D).
		slog.ErrorContext(ctx, "order processing failed", "orderId", orderID, "entryId", msg.ID, "err", err)
	}
}
