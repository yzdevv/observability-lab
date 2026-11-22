// Command order-go is the Go implementation of the order API and worker.
// MODE=api serves HTTP, MODE=worker consumes the order stream. Both follow docs/API-CONTRACT.md.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/exaring/otelpgx"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/contrib/bridges/otelslog"
)

const impl = "go"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	if err := run(); err != nil {
		slog.Error("exit", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	service := "order-api-go"
	if cfg.Mode == "worker" {
		service = "worker-go"
	}
	stdout := traceLogHandler{slog.NewJSONHandler(os.Stdout, nil)}
	slog.SetDefault(slog.New(stdout).With("service", service, "impl", impl))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	shutdownTelemetry, err := setupTelemetry(ctx)
	if err != nil {
		return fmt.Errorf("telemetry: %w", err)
	}
	if os.Getenv("OTEL_LOGS_EXPORTER") != "none" {
		// Logs also go over OTLP to Loki; the bridge reads trace and span IDs from the context.
		slog.SetDefault(slog.New(fanoutHandler{stdout, otelslog.NewHandler(service)}).With("service", service, "impl", impl))
	}
	defer func() {
		// Flush buffered spans; the signal context is already cancelled at this point.
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTelemetry(flushCtx)
	}()

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	poolCfg.MaxConns = cfg.DBPoolMax
	poolCfg.ConnConfig.Tracer = otelpgx.NewTracer()
	db, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return fmt.Errorf("connect postgres: %w", err)
	}
	defer db.Close()
	// Pool size, in-use and waiting connections as metrics (the Node pg instrumentation does the same).
	if err := otelpgx.RecordStats(db); err != nil {
		return fmt.Errorf("pool metrics: %w", err)
	}

	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("parse REDIS_URL: %w", err)
	}
	rdb := redis.NewClient(redisOpts)
	rdb.AddHook(redisTracingHook{addr: redisOpts.Addr})
	defer rdb.Close()

	svc := &Service{cfg: cfg, db: db, rdb: rdb}
	switch cfg.Mode {
	case "api":
		return runAPI(ctx, svc)
	case "worker":
		return runWorker(ctx, svc)
	default:
		return fmt.Errorf("unknown MODE %q (want api or worker)", cfg.Mode)
	}
}
