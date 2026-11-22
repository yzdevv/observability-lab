package main

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// Delayed retries for the worker, identical in both implementations (see docs/API-CONTRACT.md).
// A failed message is acknowledged and parked in a sorted set scored by its due time; a short loop
// moves due entries back onto the stream. The retry keeps the original trace context, so every
// attempt is a sibling span under the request's order.enqueue span.

type queueMessage struct {
	OrderID     string `json:"orderId"`
	Scenario    string `json:"scenario"`
	Attempt     int    `json:"attempt"`
	Traceparent string `json:"traceparent"`
	Tracestate  string `json:"tracestate"`
}

// Moves due retries from the sorted set to the stream in one atomic step (same text in Node).
var promoteRetries = redis.NewScript(`
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 50)
for _, member in ipairs(due) do
  redis.call('ZREM', KEYS[1], member)
  local m = cjson.decode(member)
  redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*',
    'orderId', m.orderId, 'scenario', m.scenario, 'attempt', tostring(m.attempt),
    'traceparent', m.traceparent, 'tracestate', m.tracestate)
end
return #due`)

const recordFailedAttemptSQL = `
UPDATE orders SET attempts = attempts + 1
WHERE id = $1 AND status = 'queued'`

const failOrderSQL = `
UPDATE orders SET status = 'failed', attempts = attempts + 1, processed_at = now()
WHERE id = $1 AND status = 'queued'`

// retryDelay is the backoff before the next attempt: base × 2^(attempt-1).
func (s *Service) retryDelay(failedAttempt int) time.Duration {
	return s.cfg.RetryBase << (failedAttempt - 1)
}

func (s *Service) scheduleRetry(ctx context.Context, m queueMessage) (time.Duration, error) {
	delay := s.retryDelay(m.Attempt)
	if _, err := s.db.Exec(ctx, recordFailedAttemptSQL, m.OrderID); err != nil {
		return 0, err
	}
	m.Attempt++
	member, err := json.Marshal(m)
	if err != nil {
		return 0, err
	}
	due := float64(time.Now().Add(delay).UnixMilli())
	return delay, s.rdb.ZAdd(ctx, retryKey(), redis.Z{Score: due, Member: string(member)}).Err()
}

func (s *Service) failOrder(ctx context.Context, orderID string) error {
	_, err := s.db.Exec(ctx, failOrderSQL, orderID)
	return err
}

func (s *Service) promoteDueRetries(ctx context.Context) error {
	return promoteRetries.Run(ctx, s.rdb, []string{retryKey(), streamKey()},
		time.Now().UnixMilli(), s.cfg.StreamMaxLen).Err()
}
