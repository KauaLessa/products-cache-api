"""Turns the saved load test results into comparable tables (CSV) and charts (PNG).

Reads every pair of files written by loadtest/run.sh in loadtest/results/:
    <name>-k6.json   client view: latency percentiles, staleness metrics
    <name>-api.json  API view (GET /metrics): settings, hit rate, load on MongoDB
and writes to loadtest/results/charts/:
    read-runs.csv, staleness-runs.csv    one row per run (raw data, consolidated)
    latency-<dist>.png                   p50 and p95 latency x concurrent clients
    throughput-<dist>.png                reads per second x concurrent clients
    db-load-<dist>.png                   MongoDB queries per read x concurrent clients
    hit-rate-<dist>.png                  hit rate x concurrent clients
    staleness.png                        time until a write becomes visible, per configuration

Run names carry the configuration (see run.sh):
    <strategy>[-noinvalidate]-<dist>-<N>vus-<timestamp>     read runs
    <strategy>[-noinvalidate]-staleness-<timestamp>         staleness runs
When the same configuration ran more than once, the most recent run is used.

Usage: loadtest/plot.sh (runs this script in Docker), or: python3 loadtest/plot.py [results dir]
"""

import csv
import json
import re
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # render to files, no display needed
import matplotlib.pyplot as plt  # noqa: E402

READ_RUN = re.compile(r"^(?P<label>.+)-(?P<dist>hotset|uniform)-(?P<vus>\d+)vus-(?P<ts>\d{8}-\d{6})$")
STALENESS_RUN = re.compile(r"^(?P<label>.+)-staleness-(?P<ts>\d{8}-\d{6})$")

# Same color and order for a configuration in every chart.
LABELS = ["none", "cache-aside", "cache-aside-noinvalidate", "write-through"]
COLORS = {
    "none": "#7f7f7f",
    "cache-aside": "#1f77b4",
    "cache-aside-noinvalidate": "#9ecae1",
    "write-through": "#d62728",
}


def label_order(label):
    return LABELS.index(label) if label in LABELS else len(LABELS)


def load_runs(results_dir):
    """Returns (read_runs, staleness_runs): one dict per run, latest run per configuration."""
    reads, staleness = {}, {}
    for k6_file in sorted(results_dir.glob("*-k6.json")):
        name = k6_file.name.removesuffix("-k6.json")
        api_file = results_dir / f"{name}-api.json"
        if not api_file.exists():
            print(f"skipping {name}: no -api.json")
            continue
        k6 = json.loads(k6_file.read_text())["metrics"]
        api = json.loads(api_file.read_text())

        if match := READ_RUN.match(name):
            row = read_row(match, k6, api)
            reads[(row["label"], row["dist"], row["vus"])] = row  # sorted by name: the latest wins
        elif match := STALENESS_RUN.match(name):
            row = staleness_row(match, k6, api)
            staleness[row["label"]] = row
        else:
            print(f"skipping {name}: unknown run name")
    return list(reads.values()), list(staleness.values())


def trend(k6, metric, stat):
    """A statistic of a k6 Trend in ms, or None when the metric has no samples."""
    values = k6.get(metric)
    if not values or values.get("max", 0) == 0:
        return None
    return round(values[stat], 3)


def read_row(match, k6, api):
    reads = api["reads"]
    settings = api.get("settings") or {}
    return {
        "label": match["label"],
        "dist": match["dist"],
        "vus": int(match["vus"]),
        "timestamp": match["ts"],
        "ttl_seconds": settings.get("ttlSeconds"),
        "reads": reads["count"],
        # API window (reset -> end of run): k6's own rate also counts the warm-up.
        "throughput_rps": round(reads["count"] / api["windowSeconds"], 1),
        "p50_ms": trend(k6, "read_latency", "med"),
        "p95_ms": trend(k6, "read_latency", "p(95)"),
        "p99_ms": trend(k6, "read_latency", "p(99)"),
        "hit_avg_ms": trend(k6, "read_latency{cache:HIT}", "avg"),
        "miss_avg_ms": trend(k6, "read_latency{cache:MISS}", "avg"),
        "hit_rate": reads["hitRate"] if api["strategy"] != "none" else None,
        "served_from_cache": reads["servedFromCache"] if api["strategy"] != "none" else None,
        "db_reads_per_read": api["source"]["readsPerReadRequest"],
    }


def staleness_row(match, k6, api):
    settings = api.get("settings") or {}
    window = k6.get("staleness_window", {})
    return {
        "label": match["label"],
        "timestamp": match["ts"],
        "ttl_seconds": settings.get("ttlSeconds"),
        "writes": window.get("count", 0),
        "stale_after_write": k6.get("stale_after_write", {}).get("value", 0),
        "stale_reads": k6.get("stale_reads", {}).get("count", 0),
        "window_avg_ms": round(window.get("avg", 0), 1),
        "window_max_ms": round(window.get("max", 0), 1),
    }


def write_csv(path, rows):
    if not rows:
        return
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {path}")


def line_chart(rows, dist, metrics, ylabel, title, path, percent=False):
    """One line per configuration (and per metric when several), x = concurrent clients."""
    fig, ax = plt.subplots(figsize=(8, 5))
    plotted = False
    for label in sorted({r["label"] for r in rows}, key=label_order):
        points = sorted((r for r in rows if r["label"] == label), key=lambda r: r["vus"])
        for metric, style, suffix in metrics:
            xy = [(r["vus"], r[metric]) for r in points if r[metric] is not None]
            if not xy:
                continue
            xs, ys = zip(*xy)
            if percent:
                ys = [y * 100 for y in ys]
            ax.plot(xs, ys, style, marker="o", color=COLORS.get(label), label=f"{label}{suffix}")
            plotted = True
    if not plotted:
        plt.close(fig)
        return
    ttl = sorted({r["ttl_seconds"] for r in rows if r["ttl_seconds"]})
    subtitle = f"distribution: {dist}" + (f", TTL: {', '.join(map(str, ttl))} s" if ttl else "")
    ax.set_title(f"{title}\n{subtitle}", fontsize=11)
    ax.set_xlabel("concurrent clients (k6 VUs)")
    ax.set_ylabel(ylabel)
    ax.set_xticks(sorted({r["vus"] for r in rows}))
    if percent:
        ax.set_ylim(0, 105)
    else:
        ax.set_ylim(bottom=0)
    ax.grid(alpha=0.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
    print(f"wrote {path}")


def read_charts(rows, out):
    for dist in sorted({r["dist"] for r in rows}):
        subset = [r for r in rows if r["dist"] == dist]
        line_chart(subset, dist, [("p50_ms", "-", " p50"), ("p95_ms", "--", " p95")],
                   "latency (ms)", "Read latency", out / f"latency-{dist}.png")
        line_chart(subset, dist, [("throughput_rps", "-", "")],
                   "reads per second", "Throughput", out / f"throughput-{dist}.png")
        line_chart(subset, dist, [("db_reads_per_read", "-", "")],
                   "MongoDB queries per read", "Load on the database", out / f"db-load-{dist}.png")
        line_chart(subset, dist, [("hit_rate", "-", "")],
                   "hit rate (%)", "Cache hit rate", out / f"hit-rate-{dist}.png", percent=True)


def staleness_chart(rows, out):
    if not rows:
        return
    rows = sorted(rows, key=lambda r: label_order(r["label"]))
    fig, ax = plt.subplots(figsize=(8, 5))
    labels = [r["label"] for r in rows]
    windows = [r["window_avg_ms"] / 1000 for r in rows]
    bars = ax.bar(labels, windows, color=[COLORS.get(l) for l in labels])
    for bar, r in zip(bars, rows):
        ax.annotate(
            f"{r['window_avg_ms'] / 1000:.2f} s\n{r['stale_after_write'] * 100:.0f}% stale",
            (bar.get_x() + bar.get_width() / 2, bar.get_height()),
            ha="center", va="bottom", fontsize=9,
        )
    ttl = sorted({r["ttl_seconds"] for r in rows if r["ttl_seconds"]})
    if len(ttl) == 1:
        ax.axhline(ttl[0], color="black", linestyle=":", linewidth=1, label=f"TTL = {ttl[0]} s")
        ax.legend()
    ax.set_title("Time until a write is visible to readers\n(average per write; % = writes whose first read was stale)",
                 fontsize=11)
    ax.set_ylabel("staleness window (s)")
    ax.set_ylim(0, max(windows + ttl + [1]) * 1.25)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    path = out / "staleness.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    print(f"wrote {path}")


def main():
    results_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "results"
    out = results_dir / "charts"
    out.mkdir(parents=True, exist_ok=True)

    reads, staleness = load_runs(results_dir)
    if not reads and not staleness:
        sys.exit(f"no results found in {results_dir}")

    reads.sort(key=lambda r: (r["dist"], label_order(r["label"]), r["vus"]))
    write_csv(out / "read-runs.csv", reads)
    staleness.sort(key=lambda r: label_order(r["label"]))
    write_csv(out / "staleness-runs.csv", staleness)
    read_charts(reads, out)
    staleness_chart(staleness, out)


if __name__ == "__main__":
    main()
