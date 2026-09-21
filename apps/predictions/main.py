"""Predictions service (Phase 5): forecasts tenant series and stores them in
the predictions table (RLS-scoped upsert via app_role + tenant GUC)."""
import json
import os
from datetime import date

from fastapi import FastAPI, Header, HTTPException

from db import tenant_query
from forecaster import run_forecast, HORIZON, MIN_HISTORY
from series import SERIES

app = FastAPI(title="rubbertrack-predictions")


def _next_months(last_month, n):
    """Roll month strings forward from the last history month."""
    y, m = int(last_month[:4]), int(last_month[5:7])
    out = []
    for _ in range(n):
        m += 1
        if m > 12:
            y, m = y + 1, 1
        out.append(f"{y:04d}-{m:02d}")
    return out


@app.get("/health")
def health():
    return {"ok": True, "service": "predictions"}


@app.get("/series")
def list_series():
    return {"series": [{"key": k, "label": v["label"]} for k, v in SERIES.items()]}


@app.post("/forecast")
def forecast(body: dict, x_tenant_id: str = Header(None)):
    tenant = x_tenant_id or body.get("tenant")
    if not tenant:
        raise HTTPException(status_code=400, detail="x-tenant-id required")
    series = body.get("series", "record_mt")
    if series not in SERIES:
        raise HTTPException(status_code=400, detail=f"unknown series: {series}")

    rows = tenant_query(tenant, SERIES[series]["sql"])
    history = [r["v"] for r in rows]
    result = run_forecast(history)

    if not result.get("ok"):
        return {"tenant": tenant, "series": series, "ok": False,
                "error": result["error"], "points": result.get("points"),
                "minimum": result.get("minimum", MIN_HISTORY)}

    forecast_rows = []
    if rows:
        months = _next_months(rows[-1]["m"], HORIZON)
        forecast_rows = [{"m": m, "v": v} for m, v in zip(months, result["forecast"])]

    # Idempotent per (tenant, series): retraining replaces the stored forecast.
    tenant_query(
        tenant,
        """INSERT INTO predictions (tenant_id, series, model, horizon, history, forecast)
           VALUES (app.current_tenant(), %s, %s, %s, %s, %s)
           ON CONFLICT (tenant_id, series) DO UPDATE SET
             model = EXCLUDED.model, horizon = EXCLUDED.horizon,
             history = EXCLUDED.history, forecast = EXCLUDED.forecast,
             generated_at = now()""",
        (series, result["model"], HORIZON, json.dumps(rows), json.dumps(forecast_rows)),
    )

    return {"tenant": tenant, "series": series, "ok": True,
            "label": SERIES[series]["label"], "model": result["model"],
            "horizon": HORIZON, "history": rows, "forecast": forecast_rows,
            "generated_at": date.today().isoformat()}


# ---- Phase 5 completion: win-probability (deal outcome) ----
from winprob import train as train_winprob, predict as predict_winprob  # noqa: E402
from mitra_winprob import (  # noqa: E402
    mitra_available, train_mitra, holdout_accuracy, batch_predict_mitra,
)

_WINPROB_CACHE = {}
_MITRA_CACHE = {}


def _trained(tenant):
    """Train (and cache per process) on the tenant's deal_history corpus."""
    if tenant not in _WINPROB_CACHE:
        history = tenant_query(
            tenant,
            "SELECT value, stage, company_type, source, days_open, activities_count, won "
            "FROM deal_history",
        )
        _WINPROB_CACHE[tenant] = train_winprob(history)
    return _WINPROB_CACHE[tenant]


_MITRA_CORPUS_SQL = (
    "SELECT value, stage, company_type, source, days_open, activities_count, won "
    "FROM deal_history"
)


def _challenger_payload(mt):
    if mt["ok"]:
        out = {"ok": True, "n": mt["n"]}
        if mt.get("accuracy") is not None:
            out["accuracy"] = round(mt["accuracy"], 4)
        return out
    return {"ok": False, "error": mt.get("error", "mitra unavailable")}


def _trained_mitra(tenant):
    if tenant not in _MITRA_CACHE:
        if not mitra_available():
            _MITRA_CACHE[tenant] = {"ok": False, "error": "mitra disabled"}
        else:
            history = tenant_query(tenant, _MITRA_CORPUS_SQL)
            t = train_mitra(history)
            if t["ok"]:
                t["accuracy"] = holdout_accuracy(t, history)
            _MITRA_CACHE[tenant] = t
    return _MITRA_CACHE[tenant]


@app.get("/win-probability/model")
def win_probability_model(x_tenant_id: str = Header(None)):
    if not x_tenant_id:
        raise HTTPException(status_code=400, detail="x-tenant-id required")
    t = _trained(x_tenant_id)
    if not t["ok"]:
        return t
    challenger = _challenger_payload(_trained_mitra(x_tenant_id))
    return {
        "ok": True,
        "n": t["n"],
        "accuracy": round(t["accuracy"], 4),
        "pseudo_r2": round(t["pseudo_r2"], 4),
        "coef": dict(zip(t["feature_names"], [round(c, 4) for c in t["coef"]])),
        "challenger": challenger,
    }


@app.post("/win-probability")
def win_probability(body: dict, x_tenant_id: str = Header(None)):
    tenant = x_tenant_id or body.get("tenant")
    deal_id = body.get("deal_id")
    want_mitra = (body.get("model") or "").lower() == "mitra"
    if not tenant or not deal_id:
        raise HTTPException(status_code=400, detail="x-tenant-id and deal_id required")
    t = _trained(tenant)
    if not t["ok"]:
        return {"ok": False, "error": t["error"]}
    model_meta = {"name": "logit", "n": t["n"], "accuracy": round(t["accuracy"], 4)}
    use_mitra = False
    if want_mitra:
        mt = _trained_mitra(tenant)
        if mt["ok"]:
            use_mitra = True
        else:
            model_meta["fallback"] = mt.get("error", "mitra unavailable")
    deals = tenant_query(
        tenant,
        """SELECT d.name, d.value::float AS value, d.stage,
                  coalesce(c.type, '') AS company_type,
                  coalesce(l.source, 'outbound') AS source,
                  extract(epoch from (now() - d.created_at))::int / 86400 AS days_open,
                  (SELECT count(*) FROM activities a
                     WHERE a.entity = 'deal' AND a.entity_id = d.id)::int AS activities_count
           FROM deals d
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN leads l ON l.id = d.lead_id
           WHERE d.id = %s""",
        (deal_id,),
    )
    if not deals:
        return {"ok": False, "error": "deal not found in this tenant"}
    if use_mitra:
        mt = _trained_mitra(tenant)
        p = batch_predict_mitra([deals[0]], mt)
        if p["ok"]:
            meta = {"name": "mitra", **_challenger_payload(mt)}
            del meta["ok"]
            return {
                "ok": True,
                "deal": deals[0].get("name"),
                "deal_id": deal_id,
                "probability": p["probabilities"][0],
                "model": meta,
            }
        model_meta["fallback"] = p.get("error", "mitra predict failed")
    p = predict_winprob(deals[0], t)
    if not p["ok"]:
        return p
    return {
        "ok": True,
        "deal": deals[0].get("name"),
        "deal_id": deal_id,
        "probability": p["probability"],
        "model": model_meta,
    }
