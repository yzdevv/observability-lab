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
	orderID, _ := msg.Values["orderId"].(string)
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	fail := func(err error) {
		// Left unacked: stays in the pending list (reclaimed in Milestone D).
		slog.Error("order processing failed", "orderId", orderID, "entryId", msg.ID, "err", err)
	}
	if orderID == "" {
		fail(errors.New("message without orderId"))
		return
	}

	time.Sleep(s.cfg.Work) // simulated work, identical in both implementations
	updated, err := s.completeOrder(ctx, orderID)
	if err != nil {
		fail(err)
		return
	}
	if err := s.rdb.XAck(ctx, stream, consumerGroup, msg.ID).Err(); err != nil {
		fail(fmt.Errorf("ack: %w", err))
		return
	}
	slog.Info("order processed", "orderId", orderID, "entryId", msg.ID, "updated", updated,
		"durationMs", time.Since(start).Milliseconds())
}
