import sys
sys.path.insert(0, ".")
from forecaster import run_forecast, MIN_HISTORY


def test_cold_start_rejected():
    out = run_forecast([100.0, 120.0, 90.0])
    assert out["ok"] is False
    assert out["error"] == "insufficient data"
    assert out["points"] == 3
    assert out["minimum"] == MIN_HISTORY


def test_forecast_shape_and_sanity():
    history = [70 + 45 * ((i % 12) / 12.0) + (i % 5) * 2 for i in range(24)]
    out = run_forecast(history)
    assert out["ok"] is True
    assert out["model"] in ("holt-damped", "chronos-bolt")
    assert len(out["forecast"]) == 6
    assert all(v > 0 for v in out["forecast"])


def test_flat_series_forecasts_near_mean():
    out = run_forecast([100.0] * 20)
    assert out["ok"] is True
    assert all(abs(v - 100.0) < 20 for v in out["forecast"])
