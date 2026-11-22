package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// worker-retry is handled by the worker; the others by the order API.
var scenarios = []string{"none", "slow-db", "cache-miss", "worker-retry", "dependency-timeout"}

var (
	productIDPattern = regexp.MustCompile(`^demo-\d{3}$`)
	uuidPattern      = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

type Service struct {
	cfg     Config
	db      *pgxpool.Pool
	rdb     *redis.Client
	payment *paymentClient
}

type httpError struct {
	status int
	msg    string
	reason string // optional machine-readable cause, e.g. "circuit-open"
}

func (e *httpError) Error() string { return e.msg }

func badRequest(msg string) error { return &httpError{status: 400, msg: msg} }

type createOrderInput struct {
	ProductID string `json:"productId"`
	Quantity  int    `json:"quantity"`
	Scenario  string `json:"scenario"`
}

func (in *createOrderInput) validate() error {
	if !productIDPattern.MatchString(in.ProductID) {
		return badRequest("productId must look like demo-001")
	}
	if in.Quantity < 1 || in.Quantity > 10 {
		return badRequest("quantity must be an integer from 1 to 10")
	}
	if in.Scenario == "" {
		in.Scenario = "none"
	}
	for _, s := range scenarios {
		if s == in.Scenario {
			return nil
		}
	}
	return badRequest(fmt.Sprintf("scenario must be one of: %s", strings.Join(scenarios, ", ")))
}

type product struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	PriceCents int    `json:"priceCents"`
}

func (s *Service) getProduct(ctx context.Context, id, scenario string) (product, error) {
	return withSpan(ctx, "product.lookup", func(ctx context.Context, span trace.Span) (product, error) {
		var p product
		key := productKey(id)
		if scenario != "cache-miss" {
			cached, err := s.rdb.Get(ctx, key).Result()
			if err == nil && json.Unmarshal([]byte(cached), &p) == nil {
				span.SetAttributes(attribute.Bool("cache.hit", true))
				return p, nil
			}
			if err != nil && !errors.Is(err, redis.Nil) {
				return p, fmt.Errorf("cache get: %w", err)
			}
		}
		span.SetAttributes(attribute.Bool("cache.hit", false), attribute.Bool("cache.skipped", scenario == "cache-miss"))
		err := s.db.QueryRow(ctx, `SELECT id, name, price_cents FROM products WHERE id = $1`, id).
			Scan(&p.ID, &p.Name, &p.PriceCents)
		if errors.Is(err, pgx.ErrNoRows) {
			return p, &httpError{status: 404, msg: "unknown product " + id}
		}
		if err != nil {
			return p, fmt.Errorf("select product: %w", err)
		}
		encoded, _ := json.Marshal(p)
		if err := s.rdb.Set(ctx, key, encoded, s.cfg.ProductCacheTTL).Err(); err != nil {
			return p, fmt.Errorf("cache set: %w", err)
		}
		return p, nil
	}, trace.WithAttributes(attribute.String("product.id", id)))
}

// The delay for slow-db is part of the INSERT itself, so the slow span is the real query.
const insertOrderSQL = `
INSERT INTO orders (id, product_id, quantity, unit_price_cents, impl, scenario, status)
SELECT $1::uuid, $2::text, $3::int, $4::int, $5::text, $6::text, 'queued'
FROM pg_sleep($7::float8)`

type createOrderResult struct {
	OrderID string `json:"orderId"`
	Impl    string `json:"impl"`
	Status  string `json:"status"`
}

func (s *Service) createOrder(ctx context.Context, in createOrderInput) (createOrderResult, error) {
	p, err := s.getProduct(ctx, in.ProductID, in.Scenario)
	if err != nil {
		return createOrderResult{}, err
	}
	// No order without a payment authorisation; a failure here returns 503/504 to the client.
	if err := s.payment.authorize(ctx, in.Scenario); err != nil {
		return createOrderResult{}, err
	}
	orderID := uuid.NewString()
	delay := 0.0
	if in.Scenario == "slow-db" {
		delay = s.cfg.SlowDB.Seconds()
	}
	_, err = withSpan(ctx, "order.persist", func(ctx context.Context, _ trace.Span) (struct{}, error) {
		_, err := s.db.Exec(ctx, insertOrderSQL,
			orderID, p.ID, in.Quantity, p.PriceCents, impl, in.Scenario, delay)
		if err != nil {
			return struct{}{}, fmt.Errorf("insert order: %w", err)
		}
		return struct{}{}, nil
	}, trace.WithAttributes(attribute.String("order.id", orderID)))
	if err != nil {
		return createOrderResult{}, err
	}

	// Not atomic with the insert: if this fails the order stays queued (see ARCHITECTURE.md).
	_, err = withSpan(ctx, "order.enqueue", func(ctx context.Context, span trace.Span) (struct{}, error) {
		// The worker continues this trace from the traceparent carried in the message.
		carrier := propagation.MapCarrier{}
		otel.GetTextMapPropagator().Inject(ctx, carrier)
		entryID, err := s.rdb.XAdd(ctx, &redis.XAddArgs{
			Stream: streamKey(),
			MaxLen: s.cfg.StreamMaxLen,
			Approx: true,
			Values: []any{
				"orderId", orderID, "scenario", in.Scenario, "attempt", "1",
				"traceparent", carrier.Get("traceparent"), "tracestate", carrier.Get("tracestate"),
			},
		}).Result()
		if err != nil {
			return struct{}{}, fmt.Errorf("enqueue order: %w", err)
		}
		span.SetAttributes(attribute.String("messaging.message.id", entryID))
		return struct{}{}, nil
	},
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("order.id", orderID),
			attribute.String("messaging.system", "redis"),
			attribute.String("messaging.operation.type", "send"),
			attribute.String("messaging.destination.name", streamKey()),
		))
	if err != nil {
		return createOrderResult{}, err
	}
	return createOrderResult{OrderID: orderID, Impl: impl, Status: "queued"}, nil
}

type order struct {
	OrderID     string  `json:"orderId"`
	Impl        string  `json:"impl"`
	ProductID   string  `json:"productId"`
	Quantity    int     `json:"quantity"`
	Scenario    string  `json:"scenario"`
	Status      string  `json:"status"`
	Attempts    int     `json:"attempts"`
	TotalCents  *int    `json:"totalCents"`
	CreatedAt   string  `json:"createdAt"`
	ProcessedAt *string `json:"processedAt"`
}

// Same format as JavaScript's Date.toISOString, so both implementations return identical shapes.
const isoMillis = "2006-01-02T15:04:05.000Z"

func (s *Service) getOrder(ctx context.Context, id string) (order, error) {
	if !uuidPattern.MatchString(id) {
		return order{}, badRequest("order id must be a UUID")
	}
	var (
		o           order
		createdAt   time.Time
		processedAt *time.Time
	)
	err := s.db.QueryRow(ctx, `
SELECT id::text, impl, product_id, quantity, scenario, status, attempts, total_cents, created_at, processed_at
FROM orders WHERE id = $1`, id).
		Scan(&o.OrderID, &o.Impl, &o.ProductID, &o.Quantity, &o.Scenario, &o.Status, &o.Attempts,
			&o.TotalCents, &createdAt, &processedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return order{}, &httpError{status: 404, msg: "order not found"}
	}
	if err != nil {
		return order{}, fmt.Errorf("select order: %w", err)
	}
	o.CreatedAt = createdAt.UTC().Format(isoMillis)
	if processedAt != nil {
		v := processedAt.UTC().Format(isoMillis)
		o.ProcessedAt = &v
	}
	return o, nil
}

const completeOrderSQL = `
UPDATE orders
SET status = 'completed', total_cents = quantity * unit_price_cents,
    attempts = attempts + 1, processed_at = now()
WHERE id = $1 AND status = 'queued'`

func (s *Service) completeOrder(ctx context.Context, id string) (bool, error) {
	tag, err := s.db.Exec(ctx, completeOrderSQL, id)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}
