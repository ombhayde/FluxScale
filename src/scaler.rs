use crate::{
    capacity::{estimate_capacity, CapacityEstimate, CapacityPhase},
    config::ScalingConfig,
    model::{MetricSample, ScalingAction, ScalingDecision},
    predictor::predict_rps,
};

use chrono::{DateTime, Utc};
use uuid::Uuid;

const MIN_LEARNED_CAPACITY_CONFIDENCE: f64 = 0.55;

// Existing provisional policy bounds, not measured server capacity.
// These do not override a saturation-derived estimate.
const MIN_BOOTSTRAP_SAFE_RPS: f64 = 250.0;
const MAX_BOOTSTRAP_SAFE_RPS: f64 = 10_000.0;

const BOOTSTRAP_TRAFFIC_MULTIPLIER: f64 = 1.50;
const BOOTSTRAP_CPU_TARGET: f64 = 0.70;
const MIN_CPU_FOR_PROJECTION: f64 = 10.0;

const RECENT_BOOTSTRAP_SAMPLES: usize = 8;

pub fn evaluate(
    service: &str,
    history: &[MetricSample],
    config: &ScalingConfig,
    last_change_at: Option<DateTime<Utc>>,
) -> ScalingDecision {
    let latest = history
        .last()
        .expect("evaluate requires at least one sample");

    let predicted_rps = predict_rps(history, config.prediction_horizon_seconds);

    let estimate = estimate_capacity(history);

    let bootstrap_safe_capacity = adaptive_bootstrap_capacity(history);

    let (safe_capacity, capacity_reason) = select_safe_capacity(&estimate, bootstrap_safe_capacity);

    let mut desired = replicas_for(predicted_rps.max(latest.requests_per_second), safe_capacity);

    let mut reasons = vec![
        format!(
            "Predicted {:.1} RPS in {} seconds",
            predicted_rps, config.prediction_horizon_seconds,
        ),
        capacity_reason,
    ];

    if let Some(saturation) = estimate.saturation_rps_per_replica {
        reasons.push(format!(
            "Observed saturation near {:.1} RPS per \
             replica; {:.0}% operating headroom retained",
            saturation,
            (1.0 - safe_capacity / saturation).clamp(0.0, 1.0) * 100.0,
        ));
    }

    if latest.p95_latency_ms > config.target_p95_latency_ms {
        desired = desired.max(latest.current_replicas.saturating_add(1));

        reasons.push(format!(
            "P95 latency {:.1} ms exceeds {:.1} ms target",
            latest.p95_latency_ms, config.target_p95_latency_ms,
        ));
    }

    if latest.error_rate > config.max_error_rate {
        desired = desired.max(latest.current_replicas.saturating_add(1));

        reasons.push(format!(
            "Error rate {:.2}% exceeds {:.2}% target",
            latest.error_rate * 100.0,
            config.max_error_rate * 100.0,
        ));
    }

    desired = desired.clamp(config.min_replicas, config.max_replicas);

    let now = latest.timestamp;

    let elapsed = last_change_at.map(|at| (now - at).num_seconds());

    let (action, final_desired) = if desired > latest.current_replicas {
        if elapsed.is_some_and(|seconds| seconds < config.scale_up_cooldown_seconds) {
            reasons.push(
                "Scale-up cooldown is active; \
                     calculated target is preserved"
                    .into(),
            );

            (ScalingAction::Hold, desired)
        } else {
            reasons.push(
                "Forecasted demand exceeds adaptive \
                     safe capacity"
                    .into(),
            );

            (ScalingAction::ScaleUp, desired)
        }
    } else if desired < latest.current_replicas {
        let available_capacity = latest.current_replicas as f64 * safe_capacity;
        let recent: Vec<_> = history
            .iter()
            .filter(|sample| {
                (now - sample.timestamp).num_seconds() <= config.scale_down_cooldown_seconds
            })
            .collect();
        let recent_demand = recent
            .iter()
            .map(|sample| sample.requests_per_second)
            .fold(predicted_rps, f64::max);
        let recent_pressure = recent.iter().any(|sample| {
            sample.p95_latency_ms > config.target_p95_latency_ms
                || sample.error_rate > config.max_error_rate
                || (sample.requests_per_second == 0.0 && sample.active_requests > 0)
        });
        let scale_down_desired = desired.max(replicas_for(recent_demand, safe_capacity));

        let utilization = if available_capacity > 0.0 {
            recent_demand / available_capacity
        } else {
            1.0
        };

        let cooldown_complete = elapsed
            .map(|seconds| seconds >= config.scale_down_cooldown_seconds)
            .unwrap_or(true);

        if history.len() >= 3
            && utilization <= config.scale_down_utilization
            && cooldown_complete
            && !recent_pressure
            && scale_down_desired < latest.current_replicas
        {
            reasons.push(format!(
                "Recent measured and forecast utilization {:.1}% is below \
                     {:.1}% scale-down threshold",
                utilization * 100.0,
                config.scale_down_utilization * 100.0,
            ));

            (ScalingAction::ScaleDown, scale_down_desired)
        } else {
            reasons.push(
                "Scale-down stabilization conditions \
                     are not yet satisfied"
                    .into(),
            );

            (ScalingAction::Hold, latest.current_replicas)
        }
    } else {
        reasons.push(
            "Current replica count matches \
                 forecasted demand"
                .into(),
        );

        (ScalingAction::Hold, latest.current_replicas)
    };

    ScalingDecision {
        id: Uuid::new_v4(),
        service: service.to_string(),
        timestamp: now,
        action,
        current_replicas: latest.current_replicas,
        desired_replicas: final_desired,
        current_rps: latest.requests_per_second,
        predicted_rps,
        prediction_horizon_seconds: config.prediction_horizon_seconds,
        reasons,
    }
}

fn select_safe_capacity(
    estimate: &CapacityEstimate,
    bootstrap_safe_capacity: f64,
) -> (f64, String) {
    let learned = estimate
        .safe_rps_per_replica
        .filter(|capacity| capacity.is_finite() && *capacity > 0.0);

    if let Some(capacity) = learned {
        // Genuine stress evidence remains authoritative, even for services whose
        // measured safe capacity is below the provisional bootstrap floor.
        if estimate.phase == CapacityPhase::SaturationObserved {
            return (
                capacity,
                format!(
                    "Using learned safe capacity {:.1} RPS per replica \
                     (phase {:?}, confidence {:.0}%)",
                    capacity,
                    estimate.phase,
                    estimate.confidence * 100.0,
                ),
            );
        }

        if estimate.confidence >= MIN_LEARNED_CAPACITY_CONFIDENCE {
            // Healthy throughput shows what has worked, not the maximum the
            // service can handle. Repeated small requests must not replace the
            // bootstrap estimate with an artificially tiny hard ceiling.
            let provisional = capacity.max(bootstrap_safe_capacity);
            return (
                provisional,
                format!(
                    "Healthy throughput is a lower bound, not a measured capacity ceiling; \
                     observed {:.1} RPS per replica (confidence {:.0}%). \
                     No saturation observed; adaptive bootstrap estimated {:.1}, \
                     using {:.1} provisional safe RPS per replica",
                    capacity,
                    estimate.confidence * 100.0,
                    bootstrap_safe_capacity,
                    provisional,
                ),
            );
        }
    }

    (
        bootstrap_safe_capacity,
        format!(
            "Capacity learning is warming up ({}/{} healthy loaded samples, \
             confidence {:.0}%); adaptive bootstrap estimated {:.1} \
             provisional safe RPS per replica",
            estimate.healthy_samples,
            estimate.sample_count,
            estimate.confidence * 100.0,
            bootstrap_safe_capacity,
        ),
    )
}

fn adaptive_bootstrap_capacity(history: &[MetricSample]) -> f64 {
    let recent: Vec<&MetricSample> = history
        .iter()
        .rev()
        .take(RECENT_BOOTSTRAP_SAMPLES)
        .collect();

    if recent.is_empty() {
        return MIN_BOOTSTRAP_SAFE_RPS;
    }

    let observed_peak = recent
        .iter()
        .map(|sample| {
            let replicas = sample.current_replicas.max(1) as f64;

            sanitize(sample.requests_per_second) / replicas
        })
        .reduce(f64::max)
        .unwrap_or(0.0);

    let traffic_projection = observed_peak * BOOTSTRAP_TRAFFIC_MULTIPLIER;

    let mut cpu_projections: Vec<f64> = recent
        .iter()
        .filter_map(|sample| {
            if !sample.cpu_percent.is_finite()
                || sample.cpu_percent < MIN_CPU_FOR_PROJECTION
                || sample.cpu_percent > 100.0
            {
                return None;
            }

            let replicas = sample.current_replicas.max(1) as f64;

            let per_replica_rps = sanitize(sample.requests_per_second) / replicas;

            let cpu_ratio = sample.cpu_percent / 100.0;

            let projected = per_replica_rps / cpu_ratio * BOOTSTRAP_CPU_TARGET;

            projected.is_finite().then_some(projected.max(0.0))
        })
        .collect();

    cpu_projections.sort_by(f64::total_cmp);

    let cpu_projection = conservative_percentile(&cpu_projections, 0.25);

    MIN_BOOTSTRAP_SAFE_RPS
        .max(traffic_projection)
        .max(cpu_projection)
        .min(MAX_BOOTSTRAP_SAFE_RPS)
}

fn conservative_percentile(values: &[f64], quantile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let index = ((values.len() - 1) as f64 * quantile.clamp(0.0, 1.0)).round() as usize;

    values[index]
}

fn replicas_for(predicted_rps: f64, safe_capacity: f64) -> u32 {
    if !predicted_rps.is_finite() || predicted_rps <= 0.0 {
        return 0;
    }

    if !safe_capacity.is_finite() || safe_capacity <= 0.0 {
        return 1;
    }

    (predicted_rps / safe_capacity).ceil() as u32
}

fn sanitize(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};

    fn sample(second: i64, rps: f64, replicas: u32) -> MetricSample {
        MetricSample {
            timestamp: Utc.timestamp_opt(1_700_000_000, 0).unwrap() + Duration::seconds(second),

            requests_per_second: rps,
            active_requests: 0,
            p95_latency_ms: 100.0,
            error_rate: 0.0,
            cpu_percent: 50.0,
            memory_percent: 40.0,
            current_replicas: replicas,
        }
    }

    #[test]
    fn scale_in_requires_recent_demand_and_pressure_to_subside() {
        let mut config = ScalingConfig::default();
        config.scale_down_cooldown_seconds = 10;
        let mut history = vec![
            sample(0, 1200.0, 3),
            sample(1, 1000.0, 3),
            sample(2, 0.0, 3),
        ];
        history[0].p95_latency_ms = 1500.0;
        history[2].active_requests = 16;
        assert_eq!(
            evaluate("burst", &history, &config, None).action,
            ScalingAction::Hold
        );
        history.extend((3..=14).map(|second| sample(second, 0.0, 3)));
        let idle = evaluate("burst", &history, &config, None);
        assert_eq!(idle.action, ScalingAction::ScaleDown);
        assert_eq!(idle.desired_replicas, 1);

        let falling = vec![
            sample(0, 1200.0, 3),
            sample(1, 1100.0, 3),
            sample(2, 1000.0, 3),
        ];
        assert_eq!(predict_rps(&falling, 10), 0.0);
        assert!(evaluate("falling", &falling, &config, None).desired_replicas >= 2);
    }

    #[test]
    fn scales_before_rising_workload_reaches_capacity() {
        let config = ScalingConfig::default();

        let history = vec![
            sample(0, 300.0, 1),
            sample(1, 500.0, 1),
            sample(2, 700.0, 1),
        ];

        let decision = evaluate("payment-api", &history, &config, None);

        assert_eq!(decision.action, ScalingAction::ScaleUp,);

        assert!(decision.desired_replicas > 1);
    }

    #[test]
    fn never_scales_below_minimum() {
        let mut config = ScalingConfig::default();
        config.min_replicas = 2;

        let history = vec![sample(0, 10.0, 2), sample(1, 10.0, 2), sample(2, 10.0, 2)];

        let decision = evaluate("auth-api", &history, &config, None);

        assert_eq!(decision.desired_replicas, 2,);
    }

    #[test]
    fn scale_up_cooldown_preserves_calculated_target() {
        let config = ScalingConfig::default();

        let history = vec![
            sample(0, 300.0, 1),
            sample(1, 500.0, 1),
            sample(2, 700.0, 1),
        ];

        let last_change = Some(history.last().unwrap().timestamp - Duration::seconds(1));

        let decision = evaluate("payment-api", &history, &config, last_change);

        assert_eq!(decision.action, ScalingAction::Hold,);

        assert!(decision.desired_replicas > decision.current_replicas);
    }

    #[test]
    fn scale_down_waits_during_cooldown() {
        let config = ScalingConfig::default();

        let history = vec![sample(0, 50.0, 3), sample(1, 40.0, 3), sample(2, 30.0, 3)];

        let last_change = Some(history.last().unwrap().timestamp - Duration::seconds(1));

        let decision = evaluate("payment-api", &history, &config, last_change);

        assert_eq!(decision.action, ScalingAction::Hold,);

        assert_eq!(decision.desired_replicas, 3,);
    }

    #[test]
    fn adaptive_bootstrap_is_used_during_warmup() {
        let config = ScalingConfig::default();

        let history = vec![sample(0, 100.0, 1)];

        let decision = evaluate("cold-start-api", &history, &config, None);

        assert!(decision
            .reasons
            .iter()
            .any(|reason| { reason.contains("adaptive bootstrap estimated",) }));
    }

    #[test]
    fn healthy_learning_remains_provisional_without_saturation() {
        let config = ScalingConfig::default();

        let history: Vec<_> = (0..12)
            .map(|second| sample(second, 100.0 + second as f64 * 50.0, 1))
            .collect();

        let decision = evaluate("learned-api", &history, &config, None);

        assert!(decision
            .reasons
            .iter()
            .any(|reason| { reason.contains("Healthy throughput is a lower bound",) }));
    }

    #[test]
    fn saturation_capacity_keeps_operating_headroom() {
        let config = ScalingConfig::default();

        let mut history: Vec<_> = (0..8)
            .map(|second| sample(second, 200.0 + second as f64 * 60.0, 1))
            .collect();

        let mut stressed_one = sample(8, 700.0, 1);

        stressed_one.cpu_percent = 90.0;
        stressed_one.p95_latency_ms = 260.0;

        let mut stressed_two = sample(9, 720.0, 1);

        stressed_two.cpu_percent = 93.0;
        stressed_two.p95_latency_ms = 300.0;

        history.push(stressed_one);
        history.push(stressed_two);

        let decision = evaluate("saturated-api", &history, &config, None);

        assert!(decision
            .reasons
            .iter()
            .any(|reason| { reason.contains("Observed saturation",) }));
    }

    fn history_after_idle() -> Vec<MetricSample> {
        let mut history: Vec<_> = (0..60)
            .map(|second| {
                let mut idle = sample(second, 0.0, 1);
                idle.p95_latency_ms = 0.0;
                idle.cpu_percent = 0.0;
                idle
            })
            .collect();
        for (offset, rps) in [15.0, 30.0, 40.0, 45.0].into_iter().enumerate() {
            history.push(sample(60 + offset as i64, rps, 1));
        }
        history
    }

    #[test]
    fn idle_then_warmup_does_not_turn_89_rps_into_six_replicas() {
        let history = history_after_idle();
        let estimate = estimate_capacity(&history);
        let (capacity, _) = select_safe_capacity(&estimate, adaptive_bootstrap_capacity(&history));

        // Hold the forecast constant to isolate capacity selection from predictor changes.
        // Before the fix: 56 idle + 4 busy windows yield P95=15 and ceil(89/15)=6.
        assert_eq!(replicas_for(89.0, capacity).max(1), 1);
        assert!(estimate.confidence < MIN_LEARNED_CAPACITY_CONFIDENCE);
    }

    #[test]
    fn confident_trickle_traffic_is_not_a_hard_capacity_ceiling() {
        let mut history: Vec<_> = (0..30).map(|second| sample(second, 10.0, 1)).collect();
        history.push(sample(30, 45.0, 1));
        let estimate = estimate_capacity(&history);

        assert_eq!(estimate.phase, CapacityPhase::Learning);
        assert!(estimate.confidence >= MIN_LEARNED_CAPACITY_CONFIDENCE);
        let (capacity, reason) =
            select_safe_capacity(&estimate, adaptive_bootstrap_capacity(&history));

        assert_eq!(replicas_for(89.0, capacity), 1);
        assert!(reason.contains("lower bound"));
    }

    #[test]
    fn low_measured_saturation_is_not_raised_to_the_bootstrap_floor() {
        let mut history: Vec<_> = (0..8)
            .map(|second| sample(second, 5.0 + second as f64, 1))
            .collect();
        for (second, rps) in [(8, 20.0), (9, 22.0)] {
            let mut stressed = sample(second, rps, 1);
            stressed.cpu_percent = 90.0;
            stressed.p95_latency_ms = 260.0;
            history.push(stressed);
        }

        let estimate = estimate_capacity(&history);
        let (capacity, _) = select_safe_capacity(&estimate, adaptive_bootstrap_capacity(&history));

        assert_eq!(estimate.phase, CapacityPhase::SaturationObserved);
        assert!((capacity - 16.0).abs() < 1e-9);
        assert_eq!(replicas_for(89.0, capacity), 6);
    }

    #[test]
    fn warmup_still_responds_to_latency_pressure() {
        let config = ScalingConfig::default();
        let mut latest = sample(0, 45.0, 1);
        latest.p95_latency_ms = config.target_p95_latency_ms + 100.0;

        let decision = evaluate("slow-cold-start", &[latest], &config, None);

        assert_eq!(decision.action, ScalingAction::ScaleUp);
        assert_eq!(decision.desired_replicas, 2);
        assert!(decision
            .reasons
            .iter()
            .any(|reason| reason.contains("P95 latency")));
    }

    #[test]
    fn warmup_still_responds_to_error_pressure() {
        let config = ScalingConfig::default();
        let mut latest = sample(0, 45.0, 1);
        latest.error_rate = config.max_error_rate + 0.01;

        let decision = evaluate("failing-cold-start", &[latest], &config, None);

        assert_eq!(decision.action, ScalingAction::ScaleUp);
        assert_eq!(decision.desired_replicas, 2);
    }

    #[test]
    fn bootstrap_scale_up_still_respects_maximum_replicas() {
        let mut config = ScalingConfig::default();
        config.max_replicas = 2;
        let history = vec![
            sample(0, 300.0, 1),
            sample(1, 500.0, 1),
            sample(2, 700.0, 1),
        ];
        let decision = evaluate("bounded-burst", &history, &config, None);

        assert_eq!(decision.action, ScalingAction::ScaleUp);
        assert_eq!(decision.desired_replicas, 2);
    }
}
