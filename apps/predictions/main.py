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
