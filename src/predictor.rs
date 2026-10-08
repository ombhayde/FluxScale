use crate::model::MetricSample;

const FORECAST_WINDOW_SAMPLES: usize = 12;

/// Forecasts request rate using linear regression over a recent,
/// bounded telemetry window.
///
/// Using only recent samples makes the forecast react quickly to
/// both traffic spikes and workload recovery. Scale-down safety is
/// handled separately by the scaler cooldown and stabilization logic.
pub fn predict_rps(history: &[MetricSample], horizon_seconds: i64) -> f64 {
    let Some(latest) = history.last() else {
        return 0.0;
    };

    let start_index = history.len().saturating_sub(FORECAST_WINDOW_SAMPLES);

    let recent_history = &history[start_index..];

    if recent_history.len() < 3 {
        return latest.requests_per_second.max(0.0);
    }

    let origin = recent_history[0].timestamp;

    let points: Vec<(f64, f64)> = recent_history
        .iter()
        .map(|sample| {
            let elapsed_seconds = (sample.timestamp - origin).num_milliseconds() as f64 / 1_000.0;

            (elapsed_seconds, sample.requests_per_second)
        })
        .collect();

    let count = points.len() as f64;

    let mean_x = points.iter().map(|(x, _)| x).sum::<f64>() / count;

    let mean_y = points.iter().map(|(_, y)| y).sum::<f64>() / count;

    let numerator = points
        .iter()
        .map(|(x, y)| (x - mean_x) * (y - mean_y))
        .sum::<f64>();

    let denominator = points
        .iter()
        .map(|(x, _)| (x - mean_x).powi(2))
        .sum::<f64>();

    if denominator <= f64::EPSILON {
        return latest.requests_per_second.max(0.0);
    }

    let slope = numerator / denominator;

    let intercept = mean_y - slope * mean_x;

    let latest_x = points.last().map(|(x, _)| *x).unwrap_or(0.0);

    let forecast_x = latest_x + horizon_seconds.max(0) as f64;

    let forecast = intercept + slope * forecast_x;

    forecast.max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};

    fn sample(second: i64, rps: f64) -> MetricSample {
        MetricSample {
            timestamp: Utc.timestamp_opt(1_700_000_000, 0).unwrap() + Duration::seconds(second),

            requests_per_second: rps,
            active_requests: 0,
            p95_latency_ms: 100.0,
            error_rate: 0.0,
            cpu_percent: 20.0,
            memory_percent: 20.0,
            current_replicas: 1,
        }
    }

    #[test]
    fn predicts_a_linear_traffic_rise() {
        let history = vec![sample(0, 100.0), sample(1, 200.0), sample(2, 300.0)];

        let predicted = predict_rps(&history, 5);

        approx::assert_abs_diff_eq!(predicted, 800.0, epsilon = 0.001);
    }

    #[test]
    fn never_predicts_negative_traffic() {
        let history = vec![sample(0, 300.0), sample(1, 200.0), sample(2, 100.0)];

        assert_eq!(predict_rps(&history, 5), 0.0);
    }

    #[test]
    fn ignores_an_old_spike_after_recovery() {
        let mut history = Vec::new();

        for second in 0..15 {
            history.push(sample(second, 1_000.0));
        }

        for second in 15..27 {
            history.push(sample(second, 200.0));
        }

        let predicted = predict_rps(&history, 10);

        approx::assert_abs_diff_eq!(predicted, 200.0, epsilon = 0.001);
    }

    #[test]
    fn uses_latest_value_with_too_few_samples() {
        let history = vec![sample(0, 125.0), sample(1, 175.0)];

        assert_eq!(predict_rps(&history, 10), 175.0);
    }
}
