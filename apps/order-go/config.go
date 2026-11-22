package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Mode            string
	Port            string
	DatabaseURL     string
	RedisURL        string
	DBPoolMax       int32
	SlowDB          time.Duration
	ProductCacheTTL time.Duration
	StreamMaxLen    int64
	Work            time.Duration
	WorkerBatch     int64
	MaxAttempts     int
	RetryBase       time.Duration // backoff: 500 ms, 1 s, 2 s, …
	RetryPromote    time.Duration // how often due retries move back to the stream
	ReclaimIdle     time.Duration // unacked this long = its worker died; take it over
	ReclaimEvery    time.Duration
	Retention       time.Duration // orders older than this are deleted by the worker
	CleanupEvery    time.Duration

	PaymentURL        string
	DependencyTimeout time.Duration
	BreakerEnabled    bool
	BreakerFailures   int
	BreakerOpen       time.Duration

	// MODE=payment (the fake provider)
	PaymentLatency time.Duration
	DegradedDelay  time.Duration
	DegradedCycle  time.Duration
	DegradedOutage time.Duration
}

func loadConfig() (Config, error) {
	var errs []error
	intEnv := func(name string, fallback int) int {
		raw := os.Getenv(name)
		if raw == "" {
			return fallback
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < 0 {
			errs = append(errs, fmt.Errorf("%s must be a non-negative integer", name))
			return fallback
		}
		return v
	}

	cfg := Config{
		Mode:            envOr("MODE", "api"),
		Port:            envOr("PORT", "8082"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		RedisURL:        envOr("REDIS_URL", "redis://redis:6379"),
		DBPoolMax:       int32(intEnv("DB_POOL_MAX", 10)),
		SlowDB:          time.Duration(intEnv("SLOW_DB_MS", 300)) * time.Millisecond,
		ProductCacheTTL: time.Duration(intEnv("PRODUCT_CACHE_TTL_S", 60)) * time.Second,
		StreamMaxLen:    int64(intEnv("STREAM_MAXLEN", 10000)),
		Work:            time.Duration(intEnv("WORKER_WORK_MS", 20)) * time.Millisecond,
		WorkerBatch:     int64(intEnv("WORKER_BATCH", 10)),
		MaxAttempts:     intEnv("WORKER_MAX_ATTEMPTS", 3),
		RetryBase:       time.Duration(intEnv("RETRY_BASE_MS", 500)) * time.Millisecond,
		RetryPromote:    time.Duration(intEnv("RETRY_PROMOTE_MS", 250)) * time.Millisecond,
		ReclaimIdle:     time.Duration(intEnv("RECLAIM_IDLE_MS", 60000)) * time.Millisecond,
		ReclaimEvery:    time.Duration(intEnv("RECLAIM_EVERY_MS", 15000)) * time.Millisecond,
		Retention:       time.Duration(intEnv("ORDER_RETENTION_HOURS", 6)) * time.Hour,
		CleanupEvery:    time.Duration(intEnv("CLEANUP_EVERY_MS", 600000)) * time.Millisecond,

		PaymentURL:        envOr("PAYMENT_URL", "http://fake-payment:8083"),
		DependencyTimeout: time.Duration(intEnv("DEPENDENCY_TIMEOUT_MS", 500)) * time.Millisecond,
		BreakerEnabled:    envOr("BREAKER_ENABLED", "true") != "false",
		BreakerFailures:   intEnv("BREAKER_FAILURES", 5),
		BreakerOpen:       time.Duration(intEnv("BREAKER_OPEN_MS", 10000)) * time.Millisecond,

		PaymentLatency: time.Duration(intEnv("PAYMENT_LATENCY_MS", 2)) * time.Millisecond,
		DegradedDelay:  time.Duration(intEnv("DEGRADED_DELAY_MS", 3000)) * time.Millisecond,
		DegradedCycle:  time.Duration(intEnv("DEGRADED_CYCLE_S", 60)) * time.Second,
		DegradedOutage: time.Duration(intEnv("DEGRADED_OUTAGE_S", 30)) * time.Second,
	}
	if cfg.DatabaseURL == "" && cfg.Mode != "payment" {
		errs = append(errs, fmt.Errorf("missing environment variable DATABASE_URL"))
	}
	if len(errs) > 0 {
		return cfg, fmt.Errorf("config: %v", errs)
	}
	return cfg, nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

const consumerGroup = "workers"

func streamKey() string           { return "lab:" + impl + ":orders" }
func productKey(id string) string { return "lab:" + impl + ":product:" + id }
func retryKey() string            { return "lab:" + impl + ":retry" }
