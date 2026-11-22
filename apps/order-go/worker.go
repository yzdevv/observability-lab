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

	// Background loops: move due retries back onto the stream, and take over entries whose
	// worker died before acknowledging them.
	go every(ctx, s.cfg.RetryPromote, func() error { return s.promoteDueRetries(ctx) })
	go every(ctx, s.cfg.ReclaimEvery, func() error { return s.reclaimStale(ctx, stream, consumer) })

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

func every(ctx context.Context, interval time.Duration, task func() error) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := task(); err != nil && ctx.Err() == nil {
				slog.Error("background task failed", "err", err)
			}
		}
	}
}

func (s *Service) reclaimStale(ctx context.Context, stream, consumer string) error {
	msgs, _, err := s.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream: stream, Group: consumerGroup, Consumer: consumer,
		MinIdle: s.cfg.ReclaimIdle, Start: "0-0", Count: s.cfg.WorkerBatch,
	}).Result()
	if err != nil {
		return err
	}
	if len(msgs) > 0 {
		slog.Warn("reclaimed stale entries", "count", len(msgs))
	}
	workCtx := context.WithoutCancel(ctx)
	var wg sync.WaitGroup
	for _, msg := range msgs {
		wg.Go(func() { s.processMessage(workCtx, stream, msg) })
	}
	wg.Wait()
	return nil
}

var errSimulated = errors.New("simulated fulfilment failure")

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
	m := queueMessage{
		OrderID: field("orderId"), Scenario: field("scenario"), Attempt: 1,
		Traceparent: field("traceparent"), Tracestate: field("tracestate"),
	}
	if m.Scenario == "" {
		m.Scenario = "none"
	}
	fmt.Sscan(field("attempt"), &m.Attempt)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// Continue the trace started by the HTTP request that enqueued this order.
	carrier := propagation.MapCarrier{"traceparent": m.Traceparent, "tracestate": m.Tracestate}
	ctx = otel.GetTextMapPropagator().Extract(ctx, carrier)

	_, err := withSpan(ctx, "order.process", func(ctx context.Context, span trace.Span) (struct{}, error) {
		if m.OrderID == "" {
			return struct{}{}, errors.New("message without orderId")
		}
		// Simulated work, identical in both implementations.
		_, workErr := withSpan(ctx, "order.fulfil", func(context.Context, trace.Span) (struct{}, error) {
			time.Sleep(s.cfg.Work)
			if m.Scenario == "worker-retry" && m.Attempt < 3 {
				return struct{}{}, fmt.Errorf("%w (attempt %d of 3)", errSimulated, m.Attempt)
			}
			return struct{}{}, nil
		}, trace.WithAttributes(attribute.Bool("lab.simulated", true)))

		if workErr != nil {
			// Retry with backoff, or give up after the last attempt. Either way the message is done.
			if m.Attempt < s.cfg.MaxAttempts {
				delay, err := s.scheduleRetry(ctx, m)
				if err != nil {
					return struct{}{}, err
				}
				span.SetAttributes(attribute.Bool("lab.retry.scheduled", true),
					attribute.Int64("lab.retry.delay_ms", delay.Milliseconds()))
				slog.WarnContext(ctx, "order attempt failed, retry scheduled", "orderId", m.OrderID,
					"attempt", m.Attempt, "delayMs", delay.Milliseconds(), "err", workErr)
			} else {
				if err := s.failOrder(ctx, m.OrderID); err != nil {
					return struct{}{}, err
				}
				span.SetAttributes(attribute.Bool("lab.retry.exhausted", true))
				slog.ErrorContext(ctx, "order failed after last attempt", "orderId", m.OrderID,
					"attempt", m.Attempt, "err", workErr)
			}
			if err := s.rdb.XAck(ctx, stream, consumerGroup, msg.ID).Err(); err != nil {
				return struct{}{}, fmt.Errorf("ack: %w", err)
			}
			return struct{}{}, workErr // marks order.process as failed in the trace
		}

		updated, err := s.completeOrder(ctx, m.OrderID)
		if err != nil {
			return struct{}{}, err
		}
		span.SetAttributes(attribute.Bool("order.updated", updated))
		if err := s.rdb.XAck(ctx, stream, consumerGroup, msg.ID).Err(); err != nil {
			return struct{}{}, fmt.Errorf("ack: %w", err)
		}
		slog.InfoContext(ctx, "order processed", "orderId", m.OrderID, "entryId", msg.ID, "attempt", m.Attempt,
			"updated", updated, "durationMs", time.Since(start).Milliseconds())
		return struct{}{}, nil
	},
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("order.id", m.OrderID),
			attribute.String("lab.impl", impl),
			attribute.String("lab.scenario", m.Scenario),
			attribute.Int("lab.attempt", m.Attempt),
			attribute.String("messaging.system", "redis"),
			attribute.String("messaging.operation.type", "process"),
			attribute.String("messaging.destination.name", stream),
			attribute.String("messaging.message.id", msg.ID),
		))
	if err != nil && !errors.Is(err, errSimulated) {
		// Left unacked: reclaimed by another read after RECLAIM_IDLE_MS (XAUTOCLAIM).
		slog.ErrorContext(ctx, "order processing failed", "orderId", m.OrderID, "entryId", msg.ID, "err", err)
	}
}
