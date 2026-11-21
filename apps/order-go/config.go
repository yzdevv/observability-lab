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
	}
	if cfg.DatabaseURL == "" {
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
