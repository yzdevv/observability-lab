package main

import (
	"context"
	"os"
	"strconv"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

// The container's own CPU and memory accounting from cgroup v2 files: throttling and memory
// against the limit, without cAdvisor or the Docker socket. Same metric names as the Node services.

func cgroupDir() string {
	if d := os.Getenv("LAB_CGROUP_DIR"); d != "" {
		return d
	}
	return "/sys/fs/cgroup"
}

func readCgroup(file string) (string, bool) {
	b, err := os.ReadFile(cgroupDir() + "/" + file)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(b)), true
}

func cpuStat() map[string]float64 {
	out := map[string]float64{}
	text, _ := readCgroup("cpu.stat")
	for _, line := range strings.Split(text, "\n") {
		if k, v, ok := strings.Cut(line, " "); ok {
			if n, err := strconv.ParseFloat(v, 64); err == nil {
				out[k] = n
			}
		}
	}
	return out
}

func cgroupNumber(file string) (float64, bool) {
	text, ok := readCgroup(file)
	if !ok || text == "max" {
		return 0, false
	}
	n, err := strconv.ParseFloat(text, 64)
	return n, err == nil
}

func cpuLimitCores() (float64, bool) {
	text, ok := readCgroup("cpu.max")
	quota, period, found := strings.Cut(text, " ")
	if !ok || !found || quota == "max" {
		return 0, false
	}
	q, err1 := strconv.ParseFloat(quota, 64)
	p, err2 := strconv.ParseFloat(period, 64)
	if err1 != nil || err2 != nil || p == 0 {
		return 0, false
	}
	return q / p, true
}

func registerCgroupMetrics() error {
	if _, ok := readCgroup("cpu.stat"); !ok {
		return nil // not on cgroup v2
	}
	m := otel.Meter("observability-lab/cgroup")
	periods, err := m.Float64ObservableCounter("lab.cgroup.cpu.periods",
		metric.WithDescription("CFS scheduling periods elapsed (100 ms each) while the container had runnable work"))
	if err != nil {
		return err
	}
	throttled, err := m.Float64ObservableCounter("lab.cgroup.cpu.throttled_periods",
		metric.WithDescription("Periods in which the container used up its CPU quota and was paused"))
	if err != nil {
		return err
	}
	throttledTime, err := m.Float64ObservableCounter("lab.cgroup.cpu.throttled_time",
		metric.WithDescription("Total time the container was paused by its CPU quota"), metric.WithUnit("s"))
	if err != nil {
		return err
	}
	usage, err := m.Float64ObservableCounter("lab.cgroup.cpu.usage_time",
		metric.WithDescription("CPU time used"), metric.WithUnit("s"))
	if err != nil {
		return err
	}
	limit, err := m.Float64ObservableGauge("lab.cgroup.cpu.limit",
		metric.WithDescription("CPU limit in cores"), metric.WithUnit("{cpu}"))
	if err != nil {
		return err
	}
	mem, err := m.Float64ObservableGauge("lab.cgroup.memory.usage",
		metric.WithDescription("Memory in use"), metric.WithUnit("By"))
	if err != nil {
		return err
	}
	memMax, err := m.Float64ObservableGauge("lab.cgroup.memory.limit",
		metric.WithDescription("Memory limit"), metric.WithUnit("By"))
	if err != nil {
		return err
	}
	_, err = m.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		s := cpuStat()
		if v, ok := s["nr_periods"]; ok {
			o.ObserveFloat64(periods, v)
		}
		if v, ok := s["nr_throttled"]; ok {
			o.ObserveFloat64(throttled, v)
		}
		if v, ok := s["throttled_usec"]; ok {
			o.ObserveFloat64(throttledTime, v/1e6)
		}
		if v, ok := s["usage_usec"]; ok {
			o.ObserveFloat64(usage, v/1e6)
		}
		if v, ok := cpuLimitCores(); ok {
			o.ObserveFloat64(limit, v)
		}
		if v, ok := cgroupNumber("memory.current"); ok {
			o.ObserveFloat64(mem, v)
		}
		if v, ok := cgroupNumber("memory.max"); ok {
			o.ObserveFloat64(memMax, v)
		}
		return nil
	}, periods, throttled, throttledTime, usage, limit, mem, memMax)
	return err
}
