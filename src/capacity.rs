use crate::model::MetricSample;
use serde::Serialize;

const MIN_HEALTHY_SAMPLES: usize = 4;
// Isolated pressure samples remain visible, but do not establish saturation.
const MIN_STRESSED_SAMPLES: usize = 2;
const MIN_RECOVERY_SAMPLES: usize = 2;
// Do not join evidence across a telemetry gap or out-of-order timestamps.
const MAX_EVIDENCE_GAP_MS: i64 = 30_000;
const MAX_LEARNING_SAMPLES: usize = 60;
const SATURATION_HEADROOM: f64 = 0.80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapacityPhase {
    WarmingUp,
    Learning,
    SaturationObserved,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapacityEstimate {
    pub phase: CapacityPhase,
    pub safe_rps_per_replica: Option<f64>,
    pub observed_peak_rps_per_replica: f64,
    pub saturation_rps_per_replica: Option<f64>,
    pub confidence: f64,
    /// Positive-traffic windows in the recent learning window (idle windows excluded).
    pub sample_count: usize,
    pub healthy_samples: usize,
    /// All loaded pressure samples, including isolated/unconfirmed outliers.
    pub stressed_samples: usize,
    pub baseline_p95_latency_ms: f64,
    pub baseline_error_rate: f64,
}

pub fn estimate_capacity(history: &[MetricSample]) -> CapacityEstimate {
    let recent: Vec<&MetricSample> = history
        .iter()
        .rev()
        .take(MAX_LEARNING_SAMPLES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    // Heartbeats are not capacity evidence. Keep them in `recent`, however:
    // an idle window must break a supposedly consecutive stress/recovery run.
    let samples: Vec<&MetricSample> = recent
        .iter()
        .copied()
        .filter(|sample| has_loaded_traffic(sample))
        .collect();

    if samples.is_empty() {
        return empty_estimate();
    }

    let baseline_p95_latency_ms = lower_half_median(
        samples
            .iter()
            .map(|sample| sample.p95_latency_ms)
            .filter(|value| value.is_finite() && *value > 0.0)
            .collect(),
    );

    let baseline_error_rate = lower_half_median(
        samples
            .iter()
            .map(|sample| sample.error_rate)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .collect(),
    );

    let mut all_throughput = Vec::with_capacity(samples.len());
    let mut healthy_throughput = Vec::new();
    let mut stressed_throughput = Vec::new();

    for sample in &samples {
        let replicas = sample.current_replicas.max(1) as f64;
        let per_replica = sanitize(sample.requests_per_second) / replicas;

        all_throughput.push(per_replica);

        if is_stressed(sample, baseline_p95_latency_ms, baseline_error_rate) {
            stressed_throughput.push(per_replica);
        } else if is_healthy(sample, baseline_p95_latency_ms, baseline_error_rate) {
            healthy_throughput.push(per_replica);
        }
    }

    let healthy_samples = healthy_throughput.len();
    let stressed_samples = stressed_throughput.len();

    let observed_peak_rps_per_replica = percentile(&healthy_throughput, 0.95);

    let saturation_rps_per_replica =
        sustained_saturation(&recent, baseline_p95_latency_ms, baseline_error_rate);

    let phase = if saturation_rps_per_replica.is_some() {
        CapacityPhase::SaturationObserved
    } else if healthy_samples >= MIN_HEALTHY_SAMPLES {
        CapacityPhase::Learning
    } else {
        CapacityPhase::WarmingUp
    };

    let safe_rps_per_replica = match phase {
        CapacityPhase::WarmingUp => None,

        CapacityPhase::Learning => {
            (observed_peak_rps_per_replica > 0.0).then_some(observed_peak_rps_per_replica)
        }

        CapacityPhase::SaturationObserved => {
            saturation_rps_per_replica.map(|saturation| saturation * SATURATION_HEADROOM)
        }
    };

    let confidence = confidence(&all_throughput, healthy_samples, stressed_samples, phase);

    CapacityEstimate {
        phase,
        safe_rps_per_replica,
        observed_peak_rps_per_replica,
        saturation_rps_per_replica,
        confidence,
        sample_count: samples.len(),
        healthy_samples,
        stressed_samples,
        baseline_p95_latency_ms,
        baseline_error_rate,
    }
}

fn has_loaded_traffic(sample: &MetricSample) -> bool {
    sample.requests_per_second.is_finite() && sample.requests_per_second > 0.0
}

fn per_replica_rps(sample: &MetricSample) -> f64 {
    sanitize(sample.requests_per_second) / sample.current_replicas.max(1) as f64
}

fn consecutive_evidence(previous: &MetricSample, current: &MetricSample) -> bool {
    let elapsed_ms = (current.timestamp - previous.timestamp).num_milliseconds();

    elapsed_ms > 0
        && elapsed_ms <= MAX_EVIDENCE_GAP_MS
        && current.current_replicas == previous.current_replicas
}

fn finish_stress_run(run: &mut Vec<(usize, f64)>, confirmed: &mut Vec<(usize, f64)>) {
    if run.len() >= MIN_STRESSED_SAMPLES {
        confirmed.append(run);
    } else {
        run.clear();
    }
}

/// Relative latency/resource pressure is only a candidate for saturation:
/// require consecutive loaded windows and discard evidence contradicted by
/// subsequent sustained healthy throughput at the same or higher per-replica
/// load. This is a passive heuristic, not proof of a hardware capacity limit.
fn sustained_saturation(
    recent: &[&MetricSample],
    baseline_latency: f64,
    baseline_error_rate: f64,
) -> Option<f64> {
    let mut run: Vec<(usize, f64)> = Vec::new();
    let mut confirmed: Vec<(usize, f64)> = Vec::new();

    for (index, sample) in recent.iter().enumerate() {
        if !has_loaded_traffic(sample)
            || !is_stressed(sample, baseline_latency, baseline_error_rate)
        {
            finish_stress_run(&mut run, &mut confirmed);
            continue;
        }

        if let Some(&(previous_index, _)) = run.last() {
            if !consecutive_evidence(recent[previous_index], sample) {
                finish_stress_run(&mut run, &mut confirmed);
            }
        }

        run.push((index, per_replica_rps(sample)));
    }

    finish_stress_run(&mut run, &mut confirmed);

    let credible: Vec<f64> = confirmed
        .into_iter()
        .filter(|(index, _)| {
            !has_later_healthy_recovery(
                &recent[*index + 1..],
                recent[*index],
                baseline_latency,
                baseline_error_rate,
            )
        })
        .map(|(_, throughput)| throughput)
        .collect();

    if credible.len() < MIN_STRESSED_SAMPLES {
        return None;
    }

    let saturation = percentile(&credible, 0.25);
    (saturation.is_finite() && saturation > 0.0).then_some(saturation)
}

fn has_later_healthy_recovery(
    later: &[&MetricSample],
    stressed_sample: &MetricSample,
    baseline_latency: f64,
    baseline_error_rate: f64,
) -> bool {
    let mut run_length = 0usize;
    let mut previous: Option<&MetricSample> = None;

    for &sample in later {
        // Zero latency can mean no completed requests: do not treat that
        // missing latency measurement as proof of recovery.
        let recovered = has_loaded_traffic(sample)
            && sample.timestamp > stressed_sample.timestamp
            && sample.p95_latency_ms.is_finite()
            && sample.p95_latency_ms > 0.0
            && is_healthy(sample, baseline_latency, baseline_error_rate)
            && per_replica_rps(sample) >= per_replica_rps(stressed_sample);

        if !recovered {
            run_length = 0;
            previous = None;
            continue;
        }

        run_length = if previous.is_some_and(|at| consecutive_evidence(at, sample)) {
            run_length + 1
        } else {
            1
        };
        previous = Some(sample);

        if run_length >= MIN_RECOVERY_SAMPLES {
            return true;
        }
    }

    false
}

fn empty_estimate() -> CapacityEstimate {
    CapacityEstimate {
        phase: CapacityPhase::WarmingUp,
        safe_rps_per_replica: None,
        observed_peak_rps_per_replica: 0.0,
        saturation_rps_per_replica: None,
        confidence: 0.0,
        sample_count: 0,
        healthy_samples: 0,
        stressed_samples: 0,
        baseline_p95_latency_ms: 0.0,
        baseline_error_rate: 0.0,
    }
}

fn is_stressed(sample: &MetricSample, baseline_latency: f64, baseline_error_rate: f64) -> bool {
    let latency_limit = if baseline_latency > 0.0 {
        (baseline_latency * 2.0).max(baseline_latency + 50.0)
    } else {
        500.0
    };

    let error_limit = (baseline_error_rate + 0.02).max(0.03);

    sample.cpu_percent >= 85.0
        || sample.memory_percent >= 95.0
        || sample.p95_latency_ms >= latency_limit
        || sample.error_rate >= error_limit
}

fn is_healthy(sample: &MetricSample, baseline_latency: f64, baseline_error_rate: f64) -> bool {
    let latency_limit = if baseline_latency > 0.0 {
        (baseline_latency * 1.50).max(baseline_latency + 25.0)
    } else {
        500.0
    };

    sample.cpu_percent <= 80.0
        && sample.memory_percent <= 90.0
        && sample.p95_latency_ms <= latency_limit
        && sample.error_rate <= (baseline_error_rate + 0.01).max(0.02)
}

fn confidence(
    throughput: &[f64],
    healthy_samples: usize,
    stressed_samples: usize,
    phase: CapacityPhase,
) -> f64 {
    if throughput.is_empty() {
        return 0.0;
    }

    let sample_score = (throughput.len() as f64 / 30.0).clamp(0.0, 1.0);

    let healthy_score = (healthy_samples as f64 / 8.0).clamp(0.0, 1.0);

    let stress_score = (stressed_samples as f64 / MIN_STRESSED_SAMPLES as f64).clamp(0.0, 1.0);

    let positive: Vec<f64> = throughput
        .iter()
        .copied()
        .filter(|value| *value > 0.0)
        .collect();

    let minimum = positive.iter().copied().reduce(f64::min).unwrap_or(0.0);

    let maximum = positive.iter().copied().reduce(f64::max).unwrap_or(0.0);

    let range_score = if minimum > 0.0 {
        ((maximum / minimum - 1.0) / 3.0).clamp(0.0, 1.0)
    } else {
        0.0
    };

    let saturation_bonus = if phase == CapacityPhase::SaturationObserved {
        0.15 * stress_score
    } else {
        0.0
    };

    (0.40 * sample_score + 0.30 * healthy_score + 0.15 * range_score + saturation_bonus)
        .clamp(0.0, 1.0)
}

fn lower_half_median(mut values: Vec<f64>) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    values.sort_by(f64::total_cmp);

    let lower_half_len = values.len().div_ceil(2);

    median(&values[..lower_half_len])
}

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let middle = values.len() / 2;

    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2.0
    } else {
        values[middle]
    }
}

fn percentile(values: &[f64], quantile: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }

    let mut sorted: Vec<f64> = values
        .iter()
        .copied()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .collect();

    if sorted.is_empty() {
        return 0.0;
    }

    sorted.sort_by(f64::total_cmp);

    let index = ((sorted.len() - 1) as f64 * quantile.clamp(0.0, 1.0)).round() as usize;

    sorted[index]
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
    use chrono::{Duration, TimeZone, Utc};

    fn sample(
        second: i64,
        rps: f64,
        replicas: u32,
        latency: f64,
        error_rate: f64,
        cpu: f64,
    ) -> MetricSample {
        MetricSample {
            timestamp: Utc.timestamp_opt(1_700_000_000, 0).unwrap() + Duration::seconds(second),

            requests_per_second: rps,
            active_requests: 0,
            p95_latency_ms: latency,
            error_rate,
            cpu_percent: cpu,
            memory_percent: 40.0,
            current_replicas: replicas,
        }
    }

    #[test]
    fn begins_without_predefined_capacity() {
        let estimate = estimate_capacity(&[sample(0, 100.0, 1, 100.0, 0.0, 20.0)]);

        assert_eq!(estimate.phase, CapacityPhase::WarmingUp);

        assert_eq!(estimate.safe_rps_per_replica, None);
    }

    #[test]
    fn learns_from_healthy_observed_throughput() {
        let history: Vec<_> = (0..12)
            .map(|second| {
                sample(
                    second,
                    100.0 + second as f64 * 50.0,
                    1,
                    100.0,
                    0.0,
                    30.0 + second as f64,
                )
            })
            .collect();

        let estimate = estimate_capacity(&history);

        assert_eq!(estimate.phase, CapacityPhase::Learning);

        assert!(estimate
            .safe_rps_per_replica
            .is_some_and(|value| value >= 600.0));

        assert!(estimate.confidence >= 0.55);
    }

    #[test]
    fn detects_saturation_and_keeps_headroom() {
        let mut history: Vec<_> = (0..8)
            .map(|second| {
                sample(
                    second,
                    200.0 + second as f64 * 60.0,
                    1,
                    100.0,
                    0.0,
                    35.0 + second as f64 * 4.0,
                )
            })
            .collect();

        history.push(sample(8, 700.0, 1, 260.0, 0.04, 90.0));

        history.push(sample(9, 720.0, 1, 300.0, 0.05, 93.0));

        let estimate = estimate_capacity(&history);

        assert_eq!(estimate.phase, CapacityPhase::SaturationObserved);

        assert!(estimate
            .saturation_rps_per_replica
            .is_some_and(|value| value >= 700.0));

        assert!(estimate
            .safe_rps_per_replica
            .is_some_and(|value| value < 700.0));
    }

    #[test]
    fn normalizes_capacity_per_replica() {
        let history: Vec<_> = (0..10)
            .map(|second| sample(second, 600.0 + second as f64 * 20.0, 2, 100.0, 0.0, 50.0))
            .collect();

        let estimate = estimate_capacity(&history);

        assert!(estimate.observed_peak_rps_per_replica < 400.0);

        assert!(estimate.observed_peak_rps_per_replica > 300.0);
    }

    #[test]
    fn idle_heartbeats_do_not_establish_capacity_or_confidence() {
        let history: Vec<_> = (0..60)
            .map(|second| sample(second, 0.0, 1, 0.0, 0.0, 0.0))
            .collect();
        let estimate = estimate_capacity(&history);

        assert_eq!(estimate.phase, CapacityPhase::WarmingUp);
        assert_eq!(estimate.safe_rps_per_replica, None);
        assert_eq!(estimate.confidence, 0.0);
        assert_eq!(estimate.sample_count, 0);
        assert_eq!(estimate.healthy_samples, 0);
    }

    #[test]
    fn one_busy_window_after_idle_is_not_confident_learning() {
        let busy = sample(60, 15.0, 1, 100.0, 0.0, 20.0);
        let mut history: Vec<_> = (0..60)
            .map(|second| sample(second, 0.0, 1, 0.0, 0.0, 0.0))
            .collect();
        history.push(busy.clone());

        let estimate = estimate_capacity(&history);
        let busy_only = estimate_capacity(&[busy]);

        assert_eq!(estimate.phase, CapacityPhase::WarmingUp);
        assert_eq!(estimate.sample_count, 1);
        assert_eq!(estimate.healthy_samples, 1);
        assert_eq!(estimate.safe_rps_per_replica, None);
        assert_eq!(estimate.confidence, busy_only.confidence);
    }

    #[test]
    fn idle_windows_do_not_lower_the_latency_baseline() {
        let mut history: Vec<_> = (0..50)
            .map(|second| sample(second, 0.0, 1, 0.0, 0.0, 0.0))
            .collect();
        for second in 50..54 {
            history.push(sample(second, 40.0, 1, 200.0, 0.0, 20.0));
        }

        let estimate = estimate_capacity(&history);
        assert_eq!(estimate.baseline_p95_latency_ms, 200.0);
        assert_eq!(estimate.healthy_samples, 4);
        assert_eq!(estimate.stressed_samples, 0);
    }

    #[test]
    fn idle_cpu_pressure_is_not_a_throughput_saturation_measurement() {
        let history: Vec<_> = (0..20)
            .map(|second| sample(second, 0.0, 1, 0.0, 0.0, 99.0))
            .collect();
        let estimate = estimate_capacity(&history);

        assert_eq!(estimate.phase, CapacityPhase::WarmingUp);
        assert_eq!(estimate.stressed_samples, 0);
        assert_eq!(estimate.saturation_rps_per_replica, None);
    }

    #[test]
    fn heartbeat_filter_does_not_search_beyond_the_recent_window() {
        let mut history: Vec<_> = (0..12)
            .map(|second| sample(second, 600.0, 1, 100.0, 0.0, 50.0))
            .collect();
        for second in 12..72 {
            history.push(sample(second, 0.0, 1, 0.0, 0.0, 0.0));
        }

        let estimate = estimate_capacity(&history);
        assert_eq!(estimate.phase, CapacityPhase::WarmingUp);
        assert_eq!(estimate.confidence, 0.0);
    }

    fn recorded_sdk_ramp() -> Vec<MetricSample> {
        // User's 2026-09-04 capture: only the two separated ~64 ms windows
        // are under pressure. Later ~399 RPS is healthy at <1% CPU.
        let observations = [
            (29.908879607388084, 64.62930000002962, 0.26585670762122743),
            (49.97853921525984, 0.34660000004805624, 0.5164449052243516),
            (49.23943779591643, 0.36199999996460974, 0.3857089294013454),
            (49.95559946319345, 64.04159999999683, 0.26642986380369843),
            (140.01604583884915, 0.225499999942258, 0.3833772683682775),
            (199.94267643465517, 0.230600000009872, 0.258259290394763),
            (197.14516064324792, 0.23680000007152557, 0.25464583249752853),
            (199.5122722991283, 0.25250000006053597, 0.25770335171970743),
            (200.05683614715903, 0.255500000086613, 0.0),
            (318.91737119996753, 0.19700000004377216, 0.13288223799998647),
            (399.3930423934961, 0.19490000000223515, 0.5242033681414636),
        ];

        observations
            .into_iter()
            .enumerate()
            .map(|(index, (rps, latency, cpu))| {
                let mut metric = sample(index as i64, rps, 1, latency, 0.0, cpu);
                metric.memory_percent = 0.46;
                metric
            })
            .collect()
    }

    #[test]
    fn recorded_isolated_latency_spikes_never_establish_saturation() {
        let history = recorded_sdk_ramp();

        for count in 1..=history.len() {
            let estimate = estimate_capacity(&history[..count]);
            assert_ne!(estimate.phase, CapacityPhase::SaturationObserved);
            assert_eq!(estimate.saturation_rps_per_replica, None);
        }

        let estimate = estimate_capacity(&history);
        assert_eq!(estimate.phase, CapacityPhase::Learning);
        assert_eq!(estimate.stressed_samples, 2); // Still visible as raw pressure.
        assert!(estimate.observed_peak_rps_per_replica > 390.0);
        assert!(estimate.safe_rps_per_replica.unwrap() > 390.0);
    }

    #[test]
    fn recorded_ramp_does_not_drive_the_scaler_to_twenty_replicas() {
        let history = recorded_sdk_ramp();
        let decision = crate::scaler::evaluate(
            "recorded-sdk-ramp",
            &history,
            &crate::config::ScalingConfig::default(),
            None,
        );

        assert!(decision.desired_replicas >= 1);
        assert!(decision.desired_replicas <= 3);
        assert!(!decision
            .reasons
            .iter()
            .any(|reason| reason.contains("Observed saturation")));
    }

    fn stressed_history() -> Vec<MetricSample> {
        let mut history: Vec<_> = (0..8)
            .map(|second| sample(second, 100.0, 1, 100.0, 0.0, 30.0))
            .collect();
        history.push(sample(8, 200.0, 1, 260.0, 0.0, 90.0));
        history.push(sample(9, 210.0, 1, 280.0, 0.0, 93.0));
        history
    }

    #[test]
    fn two_later_healthy_higher_load_windows_invalidate_old_saturation() {
        let mut history = stressed_history();
        assert_eq!(
            estimate_capacity(&history).phase,
            CapacityPhase::SaturationObserved
        );

        history.push(sample(10, 300.0, 1, 100.0, 0.0, 40.0));
        // A single good window is not enough to invalidate stress evidence.
        assert_eq!(
            estimate_capacity(&history).phase,
            CapacityPhase::SaturationObserved
        );

        history.push(sample(11, 310.0, 1, 100.0, 0.0, 40.0));
        let estimate = estimate_capacity(&history);
        assert_eq!(estimate.phase, CapacityPhase::Learning);
        assert_eq!(estimate.saturation_rps_per_replica, None);
        assert!(estimate.safe_rps_per_replica.unwrap() >= 300.0);
    }

    #[test]
    fn recovery_at_lower_load_does_not_disprove_saturation() {
        let mut history = stressed_history();
        history.push(sample(10, 50.0, 1, 100.0, 0.0, 30.0));
        history.push(sample(11, 50.0, 1, 100.0, 0.0, 30.0));

        let estimate = estimate_capacity(&history);
        assert_eq!(estimate.phase, CapacityPhase::SaturationObserved);
        assert_eq!(estimate.safe_rps_per_replica, Some(160.0));
    }

    #[test]
    fn old_healthy_high_load_does_not_hide_a_later_degradation() {
        let mut history: Vec<_> = (0..8)
            .map(|second| sample(second, 400.0, 1, 100.0, 0.0, 40.0))
            .collect();
        history.push(sample(8, 50.0, 1, 260.0, 0.0, 90.0));
        history.push(sample(9, 55.0, 1, 280.0, 0.0, 93.0));

        let estimate = estimate_capacity(&history);
        assert_eq!(estimate.phase, CapacityPhase::SaturationObserved);
        assert_eq!(estimate.safe_rps_per_replica, Some(40.0));
    }

    #[test]
    fn idle_window_breaks_a_stress_run() {
        let history = vec![
            sample(0, 100.0, 1, 260.0, 0.0, 90.0),
            sample(1, 0.0, 1, 0.0, 0.0, 0.0),
            sample(2, 110.0, 1, 260.0, 0.0, 90.0),
        ];

        assert_eq!(estimate_capacity(&history).saturation_rps_per_replica, None);
    }

    #[test]
    fn telemetry_gap_or_duplicate_timestamp_does_not_confirm_stress() {
        for second in [0, 31] {
            let history = vec![
                sample(0, 100.0, 1, 260.0, 0.0, 90.0),
                sample(second, 110.0, 1, 260.0, 0.0, 90.0),
            ];
            assert_eq!(estimate_capacity(&history).saturation_rps_per_replica, None);
        }
    }

    #[test]
    fn recovery_is_compared_per_replica_not_by_total_traffic() {
        let mut history = stressed_history();
        history.push(sample(10, 300.0, 2, 100.0, 0.0, 40.0));
        history.push(sample(11, 310.0, 2, 100.0, 0.0, 40.0));
        // Total RPS is higher, but each replica only sees 150-155 RPS.
        assert_eq!(
            estimate_capacity(&history).phase,
            CapacityPhase::SaturationObserved
        );

        history.push(sample(12, 500.0, 2, 100.0, 0.0, 40.0));
        history.push(sample(13, 510.0, 2, 100.0, 0.0, 40.0));
        assert_eq!(estimate_capacity(&history).saturation_rps_per_replica, None);
    }

    #[test]
    fn sustained_latency_only_pressure_remains_detectable() {
        let mut history: Vec<_> = (0..8)
            .map(|second| sample(second, 100.0, 1, 100.0, 0.0, 20.0))
            .collect();
        history.push(sample(8, 200.0, 1, 260.0, 0.0, 20.0));
        history.push(sample(9, 210.0, 1, 280.0, 0.0, 20.0));

        assert_eq!(
            estimate_capacity(&history).phase,
            CapacityPhase::SaturationObserved
        );
    }

    #[test]
    fn missing_latency_is_not_proof_of_healthy_recovery() {
        let mut history = stressed_history();
        history.push(sample(10, 300.0, 1, 0.0, 0.0, 30.0));
        history.push(sample(11, 310.0, 1, 0.0, 0.0, 30.0));

        assert_eq!(
            estimate_capacity(&history).phase,
            CapacityPhase::SaturationObserved
        );
    }

    #[test]
    fn original_680_rps_calibration_still_retains_twenty_percent_headroom() {
        let mut history: Vec<_> = [80.0, 120.0, 180.0, 240.0, 320.0, 420.0, 520.0, 600.0]
            .into_iter()
            .enumerate()
            .map(|(index, rps)| sample(index as i64, rps, 1, 100.0, 0.0, 50.0))
            .collect();
        history.push(sample(8, 680.0, 1, 280.0, 0.0, 90.0));
        history.push(sample(9, 710.0, 1, 330.0, 0.0, 94.0));

        assert_eq!(
            estimate_capacity(&history).safe_rps_per_replica,
            Some(544.0)
        );
    }
}
