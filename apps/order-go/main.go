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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
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
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", service, "impl", impl))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	poolCfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	poolCfg.MaxConns = cfg.DBPoolMax
	db, err := pgxpool.NewWithConfig(ctx, poolCfg)
	if err != nil {
		return fmt.Errorf("connect postgres: %w", err)
	}
	defer db.Close()

	redisOpts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("parse REDIS_URL: %w", err)
	}
	rdb := redis.NewClient(redisOpts)
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
