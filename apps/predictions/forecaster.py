"""Forecasters: damped-trend exponential smoothing (statsmodels, always
available) with a Chronos-Bolt hook (AutoGluon) that activates when the heavy
stack is importable — the plan's Combo A, with the documented fallback path."""

MIN_HISTORY = 8
HORIZON = 6


def _chronos_available():
    # Opt-in: the heavy stack must both import AND be explicitly enabled, so the
    # verified damped-ETS path stays the deterministic default.
    import os
    if os.environ.get("PREDICTIONS_USE_CHRONOS") != "1":
        return False
    try:
        import autogluon.timeseries  # noqa: F401
        return True
    except Exception:
        return False


def forecast_arima(history):
    """Holt exponential smoothing with a DAMPED trend: a solid statistical
    fallback that stays sane on recent spikes (unlike trend-extrapolating
    ARIMA, which runs away on a single outlying month)."""
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    fit = ExponentialSmoothing(history, trend="add", damped_trend=True,
                               seasonal=None, initialization_method="estimated").fit()
    fc = fit.forecast(steps=HORIZON)
    return [round(float(v), 2) for v in fc]


def forecast_chronos(history):
    """Chronos-Bolt via AutoGluon TimeSeriesPredictor (zero-shot). Wrapped so
    any failure falls back to the damped-ETS model."""
    import pandas as pd
    from autogluon.timeseries import TimeSeriesDataFrame, TimeSeriesPredictor

    df = TimeSeriesDataFrame.from_data_frame(pd.DataFrame({
        "item_id": ["series"] * len(history),
        "timestamp": pd.date_range("2000-01-01", periods=len(history), freq="MS"),
        "target": history,
    }))
    pred = TimeSeriesPredictor(prediction_length=HORIZON, verbosity=0)
    pred.fit(df, hyperparameters={"Chronos": {"model_path": "bolt_base"}},
             skip_model_selection=True)
    out = pred.predict(df)
    vals = out.loc["series"]["mean"].tolist()
    return [round(float(v), 2) for v in vals]


def run_forecast(history):
    """Returns {ok, model, forecast} or {ok: False, error, points} for a cold
    tenant — never fabricates a forecast from insufficient data."""
    if len(history) < MIN_HISTORY:
        return {"ok": False, "error": "insufficient data", "points": len(history),
                "minimum": MIN_HISTORY}
    try:
        if _chronos_available():
            return {"ok": True, "model": "chronos-bolt", "forecast": forecast_chronos(history)}
    except Exception:
        pass  # fall back on any Chronos failure
    try:
        return {"ok": True, "model": "holt-damped", "forecast": forecast_arima(history)}
    except Exception as e:
        return {"ok": False, "error": f"forecast failed: {str(e)[:120]}"}
