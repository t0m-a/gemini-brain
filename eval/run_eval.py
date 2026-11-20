#!/usr/bin/env python3
"""
eval/run_eval.py — Read-Only Retrieval Evaluation Harness for Gemini Brain (brain.tsimon.me)

Evaluates live or local hybrid_recall quality against a versioned golden dataset
(default: eval/golden_queries.json; supports private eval/golden_queries.local.json).

Metrics computed:
  - Fact Recall Rate    : % of queries matching all required_facts_all (case-insensitive)
  - ID Recall@K & MRR   : For queries specifying required_ids_any, hit rate and Mean Reciprocal Rank
  - Origin Federation % : % of queries returning all expected_origins (brain.tsimon.me / kb.tsimon.me)
  - Forbidden Leakage % : % of queries leaking any forbidden_ids (superseded / synthetic test noise)
  - Token Budget Pass % : % of queries respecting tokensUsed <= tokenBudget
  - P50 / P95 Latency   : Median and 95th-percentile recall latency in milliseconds

Usage:
  python eval/run_eval.py
  python eval/run_eval.py --save-baseline eval/baseline.local.json
  python eval/run_eval.py --compare eval/baseline.local.json
  python eval/run_eval.py --dataset eval/golden_queries.local.json --fail-below-fact-recall 0.85
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional


REPO_ROOT = Path(__file__).resolve().parent.parent


def load_bearer_token() -> str:
    token = os.environ.get("MCP_BEARER_TOKEN", "").strip()
    if token:
        return token
    dev_vars = REPO_ROOT / ".dev.vars"
    if dev_vars.exists():
        for line in dev_vars.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("MCP_BEARER_TOKEN="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val:
                    return val
    return ""


def percentile(values: List[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = max(0, min(len(ordered) - 1, math.ceil((pct / 100.0) * len(ordered)) - 1))
    return ordered[idx]


def call_audit_recall(
    base_url: str,
    bearer_token: str,
    query: str,
    namespace: str,
    token_budget: int,
    half_life_days: Optional[int] = None,
) -> tuple[Dict[str, Any], float]:
    payload: Dict[str, Any] = {
        "query": query,
        "namespace": namespace,
        "tokenBudget": token_budget,
    }
    if half_life_days is not None:
        payload["halfLifeDays"] = half_life_days

    req = urllib.request.Request(
        f"{base_url}/audit/recall",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {bearer_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "BrainEvalHarness/1.0",
        },
        method="POST",
    )
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=30) as resp:
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        body = json.loads(resp.read().decode("utf-8"))
        return body, elapsed_ms


def evaluate_query(
    spec: Dict[str, Any],
    base_url: str,
    bearer_token: str,
) -> Dict[str, Any]:
    q_id = spec["id"]
    query = spec["query"]
    namespace = spec.get("namespace", "global")
    token_budget = int(spec.get("token_budget", 1600))
    half_life = spec.get("half_life_days")

    data, latency_ms = call_audit_recall(
        base_url, bearer_token, query, namespace, token_budget, half_life
    )

    compiled = str(data.get("compiledMarkdown", ""))
    compiled_lower = compiled.lower()
    candidates: List[Dict[str, Any]] = data.get("candidates", []) or []
    candidate_ids = [str(c.get("id", "")) for c in candidates]
    candidate_origins = {str(c.get("origin", "")) for c in candidates}

    # 1. Fact recall check
    required_facts_all: List[str] = spec.get("required_facts_all", [])
    missing_facts = [f for f in required_facts_all if f.lower() not in compiled_lower]
    fact_pass = len(missing_facts) == 0

    # 2. ID Recall@K & Reciprocal Rank (for queries with explicit canonical IDs)
    required_ids_any: List[str] = spec.get("required_ids_any", [])
    id_hit: Optional[bool] = None
    rr: Optional[float] = None
    matched_rank: Optional[int] = None
    if required_ids_any:
        req_set = set(required_ids_any)
        for rank_idx, cid in enumerate(candidate_ids, start=1):
            if cid in req_set:
                matched_rank = rank_idx
                rr = 1.0 / rank_idx
                break
        id_hit = matched_rank is not None
        if rr is None:
            rr = 0.0

    # 3. Expected origins check
    expected_origins: List[str] = spec.get("expected_origins", [])
    missing_origins = [o for o in expected_origins if o not in candidate_origins]
    origin_pass = len(missing_origins) == 0

    # 4. Forbidden ID leakage check
    forbidden_ids: List[str] = spec.get("forbidden_ids", [])
    leaked_ids = [fid for fid in forbidden_ids if fid in candidate_ids]
    no_leak = len(leaked_ids) == 0

    # 5. Token budget compliance
    tokens_used = int(data.get("tokensUsed", 0))
    budget_ok = tokens_used <= token_budget

    overall_pass = fact_pass and origin_pass and no_leak and budget_ok and (id_hit is not False)

    return {
        "id": q_id,
        "category": spec.get("category", "general"),
        "namespace": namespace,
        "latency_ms": round(latency_ms, 1),
        "tokens_used": tokens_used,
        "token_budget": token_budget,
        "budget_ok": budget_ok,
        "reranked": bool(data.get("reranked", False)),
        "brain_count": int(data.get("brainCount", 0)),
        "kb_count": int(data.get("kbCount", 0)),
        "graph_triples": int(data.get("graphTriplesCount", 0)),
        "fact_pass": fact_pass,
        "missing_facts": missing_facts,
        "id_hit": id_hit,
        "matched_rank": matched_rank,
        "reciprocal_rank": rr,
        "origin_pass": origin_pass,
        "missing_origins": missing_origins,
        "leaked_ids": leaked_ids,
        "no_leak": no_leak,
        "overall_pass": overall_pass,
        "top3_ids": candidate_ids[:3],
    }


def summarize_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    total = len(results)
    if total == 0:
        return {}

    fact_hits = sum(1 for r in results if r["fact_pass"])
    origin_hits = sum(1 for r in results if r["origin_pass"])
    leaks = sum(1 for r in results if not r["no_leak"])
    budget_passes = sum(1 for r in results if r["budget_ok"])
    overall_passes = sum(1 for r in results if r["overall_pass"])
    reranked_count = sum(1 for r in results if r["reranked"])

    id_scoped = [r for r in results if r["id_hit"] is not None]
    id_recall = (
        sum(1 for r in id_scoped if r["id_hit"]) / len(id_scoped) if id_scoped else 1.0
    )
    mrr = (
        sum(float(r["reciprocal_rank"] or 0.0) for r in id_scoped) / len(id_scoped)
        if id_scoped
        else 1.0
    )

    latencies = [float(r["latency_ms"]) for r in results]
    return {
        "total_queries": total,
        "overall_pass_rate": round(overall_passes / total, 4),
        "fact_recall_rate": round(fact_hits / total, 4),
        "id_recall_at_k": round(id_recall, 4),
        "id_eval_count": len(id_scoped),
        "mrr": round(mrr, 4),
        "origin_federation_rate": round(origin_hits / total, 4),
        "forbidden_leak_rate": round(leaks / total, 4),
        "budget_compliance_rate": round(budget_passes / total, 4),
        "reranker_active_rate": round(reranked_count / total, 4),
        "p50_latency_ms": round(percentile(latencies, 50), 1),
        "p95_latency_ms": round(percentile(latencies, 95), 1),
    }


def print_comparison(current: Dict[str, Any], baseline: Dict[str, Any]) -> None:
    print("\n--- Delta vs Baseline ---")
    keys = [
        ("overall_pass_rate", "Overall Pass Rate", True),
        ("fact_recall_rate", "Fact Recall Rate", True),
        ("id_recall_at_k", "ID Recall@K", True),
        ("mrr", "MRR", True),
        ("origin_federation_rate", "Origin Federation", True),
        ("forbidden_leak_rate", "Forbidden Leakage", False),
        ("budget_compliance_rate", "Budget Compliance", True),
        ("p50_latency_ms", "P50 Latency (ms)", False),
        ("p95_latency_ms", "P95 Latency (ms)", False),
    ]
    for key, label, higher_is_better in keys:
        cur = float(current.get(key, 0.0))
        base = float(baseline.get(key, 0.0))
        delta = cur - base
        if abs(delta) < 1e-6:
            tag = "(=)"
        elif (delta > 0 and higher_is_better) or (delta < 0 and not higher_is_better):
            tag = "(BETTER)"
        else:
            tag = "(REGRESSION)"
        if key.endswith("_ms"):
            print(f"  {label:<22}: {base:7.1f} -> {cur:7.1f} ({delta:+7.1f}) {tag}")
        else:
            print(f"  {label:<22}: {base*100:6.1f}% -> {cur*100:6.1f}% ({delta*100:+6.1f}pp) {tag}")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Gemini Brain Golden Retrieval Evaluation Runner")
    parser.add_argument(
        "--url",
        default=os.environ.get("BRAIN_MCP_URL", "https://brain.tsimon.me"),
        help="Target Brain base URL (default: https://brain.tsimon.me)",
    )
    parser.add_argument(
        "--dataset",
        default=str(REPO_ROOT / "eval" / "golden_queries.json"),
        help="Path to golden query JSON dataset",
    )
    parser.add_argument(
        "--category",
        default="",
        help="Optional filter by query category (e.g., homelab, tsimon.me, minkalab.net, federation)",
    )
    parser.add_argument(
        "--save-baseline",
        default="",
        help="Optional path to save full JSON eval snapshot (e.g. eval/baseline.local.json)",
    )
    parser.add_argument(
        "--compare",
        default="",
        help="Optional path to prior baseline JSON to print metric deltas",
    )
    parser.add_argument(
        "--fail-below-fact-recall",
        type=float,
        default=0.0,
        help="Exit non-zero if fact_recall_rate drops below this threshold (0.0-1.0)",
    )
    parser.add_argument(
        "--max-leak-rate",
        type=float,
        default=1.0,
        help="Exit non-zero if forbidden_leak_rate exceeds this threshold (0.0-1.0)",
    )
    args = parser.parse_args()

    base_url = args.url.rstrip("/")
    if base_url.endswith("/mcp"):
        base_url = base_url[:-4]

    bearer_token = load_bearer_token()
    if not bearer_token:
        print("FAIL: MCP_BEARER_TOKEN not found in environment or .dev.vars")
        sys.exit(1)

    dataset_path = Path(args.dataset)
    dataset = json.loads(dataset_path.read_text(encoding="utf-8"))
    queries: List[Dict[str, Any]] = dataset.get("queries", [])
    if args.category:
        queries = [q for q in queries if q.get("category") == args.category]

    print("=" * 84)
    print(f"GEMINI BRAIN RETRIEVAL EVAL | target={base_url} | queries={len(queries)}")
    print("=" * 84)

    results: List[Dict[str, Any]] = []
    for idx, spec in enumerate(queries, start=1):
        try:
            res = evaluate_query(spec, base_url, bearer_token)
        except (urllib.error.HTTPError, urllib.error.URLError, Exception) as exc:
            print(f"[{idx:02d}/{len(queries):02d}] ERROR {spec['id']}: {exc}")
            sys.exit(1)

        results.append(res)
        status_tag = "PASS" if res["overall_pass"] else "FAIL"
        rank_str = f"rank={res['matched_rank']}" if res["matched_rank"] else ("rank=MISS" if res["id_hit"] is False else "rank=n/a")
        notes: List[str] = []
        if res["missing_facts"]:
            notes.append(f"missing_facts={res['missing_facts']}")
        if res["missing_origins"]:
            notes.append(f"missing_origins={res['missing_origins']}")
        if res["leaked_ids"]:
            notes.append(f"LEAKED={res['leaked_ids']}")
        if not res["budget_ok"]:
            notes.append(f"over_budget={res['tokens_used']}/{res['token_budget']}")
        note_str = f" | {'; '.join(notes)}" if notes else ""
        print(
            f"[{idx:02d}/{len(queries):02d}] {status_tag:<4} {res['id']:<38} "
            f"{res['latency_ms']:6.0f}ms | tok={res['tokens_used']:4d}/{res['token_budget']:<4d} "
            f"| B={res['brain_count']} K={res['kb_count']} KG={res['graph_triples']:2d} | {rank_str}{note_str}"
        )

    summary = summarize_results(results)
    print("\n" + "=" * 84)
    print("EVALUATION SCORECARD")
    print("=" * 84)
    print(f"  Overall Pass Rate      : {summary['overall_pass_rate']*100:5.1f}% ({sum(1 for r in results if r['overall_pass'])}/{summary['total_queries']})")
    print(f"  Fact Recall Rate       : {summary['fact_recall_rate']*100:5.1f}%")
    print(f"  Canonical ID Recall@K  : {summary['id_recall_at_k']*100:5.1f}% (n={summary['id_eval_count']})")
    print(f"  Mean Reciprocal Rank   : {summary['mrr']:.4f}")
    print(f"  Origin Federation Rate : {summary['origin_federation_rate']*100:5.1f}%")
    print(f"  Forbidden Leakage Rate : {summary['forbidden_leak_rate']*100:5.1f}%")
    print(f"  Token Budget Compliance: {summary['budget_compliance_rate']*100:5.1f}%")
    print(f"  Cross-Encoder Active   : {summary['reranker_active_rate']*100:5.1f}%")
    print(f"  Latency (P50 / P95)    : {summary['p50_latency_ms']:.1f} ms / {summary['p95_latency_ms']:.1f} ms")

    if args.compare:
        base_path = Path(args.compare)
        if base_path.exists():
            baseline_data = json.loads(base_path.read_text(encoding="utf-8"))
            print_comparison(summary, baseline_data.get("summary", {}))
        else:
            print(f"\nWARN: Baseline file not found: {base_path}")

    if args.save_baseline:
        out_path = Path(args.save_baseline)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_payload = {
            "timestamp_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "target": base_url,
            "dataset": str(dataset_path.name),
            "summary": summary,
            "results": results,
        }
        out_path.write_text(json.dumps(out_payload, indent=2), encoding="utf-8")
        print(f"\nSaved baseline snapshot to: {out_path}")

    failed_gate = False
    if summary["fact_recall_rate"] < args.fail_below_fact_recall:
        print(f"\nGATE FAILED: fact_recall_rate {summary['fact_recall_rate']:.3f} < {args.fail_below_fact_recall:.3f}")
        failed_gate = True
    if summary["forbidden_leak_rate"] > args.max_leak_rate:
        print(f"\nGATE FAILED: forbidden_leak_rate {summary['forbidden_leak_rate']:.3f} > {args.max_leak_rate:.3f}")
        failed_gate = True

    if failed_gate:
        sys.exit(1)


if __name__ == "__main__":
    main()
