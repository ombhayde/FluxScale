"""Plot measured demo data; requires matplotlib (recording-only tooling)."""
import json
from datetime import datetime
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1]
evidence = root / "artifacts" / "demo"
report = json.loads((evidence / "result.json").read_text())
samples = json.loads((evidence / "timeline.json").read_text())
assert report["total_attempted"] == 100000
assert report["total_successful"] + report["total_failed"] == 100000
samples = [sample for sample in samples if sample.get("latest")]
assert samples
times = [datetime.fromisoformat(sample["at"].replace("Z", "+00:00")) for sample in samples]
elapsed = [(time - times[0]).total_seconds() for time in times]
fig, axes = plt.subplots(3, 1, figsize=(12, 8), sharex=True, layout="constrained")
fig.suptitle("FluxScale — measured 100,000-request local Docker demo", fontsize=17)
axes[0].plot(elapsed, [s["latest"]["requests_per_second"] for s in samples], color="#168e84")
for name, color in [("read", "#3875b3"), ("write", "#b0629b"), ("join", "#d99835"), ("cpu", "#626475")]:
    axes[0].plot(elapsed, [next((w["requests_per_second"] for w in s.get("workloads", []) if w["name"] == name), 0) for s in samples], label=name, color=color, linewidth=1)
axes[0].legend(loc="upper left", ncols=4)
axes[0].set_ylabel("SDK traffic (RPS)")
axes[1].step(elapsed, [s["healthy_replicas"] for s in samples], where="post", color="#245caf")
axes[1].set_ylabel("Healthy replicas")
axes[1].set_yticks(range(1, report["maximum_observed_replicas"] + 1))
axes[2].plot(elapsed, [s["latest"]["p95_latency_ms"] for s in samples], color="#bc6b26")
axes[2].set_ylabel("SDK window P95 (ms)")
axes[2].set_xlabel("Elapsed seconds (including setup and recovery)")
for ax in axes:
    ax.grid(alpha=0.2)
fig.text(0.5, -0.025, "Real shared PostgreSQL operations and bounded CPU loops. 100,000 total requests ≠ 100,000 RPS.\nSDK windows and generator latency percentiles measure different intervals.", ha="center", fontsize=10)
fig.savefig(evidence / "traffic-analysis.png", dpi=180, bbox_inches="tight")
fig.savefig(evidence / "traffic-analysis.pdf", bbox_inches="tight")
print("PASS: Exported measured traffic, replica and latency analysis.")
