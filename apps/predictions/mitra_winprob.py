"""Mitra challenger for win-probability (opt-in): Amazon's tabular foundation
model (Apache-2.0) via AutoGluon, zero-shot (fine_tune=False).

Contract: flag-gated (PREDICTIONS_USE_MITRA=1), per-tenant corpora, any
failure falls back to the statsmodels Logit — Mitra never breaks the endpoint.
Real fits need ~7GB RAM + GPU; unit tests use stubbed predictors only.
"""
import os

FEATURES = ["value", "stage", "company_type", "source", "days_open", "activities_count"]
LABEL = "won"


def mitra_available():
    """True only when explicitly enabled AND the heavy stack imports."""
    if os.environ.get("PREDICTIONS_USE_MITRA") != "1":
        return False
    try:
        import autogluon.tabular  # noqa: F401
        return True
    except Exception:
        return False


def _rows_to_frame(rows):
    import pandas as pd
    return pd.DataFrame([{
        "value": float(r["value"]),
        "stage": str(r.get("stage") or ""),
        "company_type": str(r.get("company_type") or ""),
        "source": str(r.get("source") or ""),
        "days_open": int(r.get("days_open") or 0),
        "activities_count": int(r.get("activities_count") or 0),
        LABEL: int(1 if r.get("won") else 0),
    } for r in rows])


def train_mitra(rows, _predictor_cls=None, _dataset_fn=None, _skip_fit=False):
    """Train a Mitra classifier on deal_history rows. Returns a dict with the
    fitted predictor under the 'predictor' key (opaque to callers)."""
    if os.environ.get("PREDICTIONS_USE_MITRA") != "1":
        return {"ok": False, "error": "MITRA disabled (set PREDICTIONS_USE_MITRA=1)"}
    rows = list(rows or [])
    labels = [1 if r.get("won") else 0 for r in rows]
    if len(set(labels)) < 2:
        return {"ok": False, "error": "training corpus has a single class"}
    if _skip_fit:
        return {"ok": False, "error": "fit skipped (test)"}
    try:
        frame = _rows_to_frame(rows)
        if _dataset_fn is not None:
            train_data = _dataset_fn(frame)
        else:
            from autogluon.tabular import TabularDataset
            train_data = TabularDataset(frame)
        if _predictor_cls is not None:
            predictor = _predictor_cls(label=LABEL)
            predictor.fit(train_data, hyperparameters={"MITRA": {"fine_tune": False}})
        else:
            from autogluon.tabular import TabularPredictor
            predictor = TabularPredictor(label=LABEL, verbosity=0)
            predictor.fit(train_data, hyperparameters={"MITRA": {"fine_tune": False}})
        return {"ok": True, "model": "mitra", "n": len(rows), "predictor": predictor}
    except Exception as e:
        return {"ok": False, "error": f"mitra train failed: {str(e)[:200]}"}


def _positive_col(proba_frame):
    """Name of the P(won) column (varies with label dtype)."""
    cols = list(proba_frame.columns)
    return next((k for k in (1, True, "1", "True", "true") if k in cols), cols[-1])


def holdout_accuracy(trained, rows, n=30):
    """Accuracy of a trained Mitra predictor on the last n corpus rows."""
    rows = list(rows or [])
    if not trained or not trained.get("ok") or trained.get("predictor") is None:
        return None
    holdout = rows[-n:] if len(rows) > n else rows
    keys = ("value", "stage", "company_type", "source", "days_open", "activities_count")
    try:
        scored = []
        for r in holdout:
            p = predict_mitra({k: r[k] for k in keys}, trained)
            if p["ok"]:
                scored.append((p["probability"] > 0.5) == bool(r["won"]))
        return (sum(scored) / len(scored)) if scored else None
    except Exception:
        return None


def batch_predict_mitra(infos, trained):
    """One predict_proba call for N deals (single in-context pass)."""
    if not trained or not trained.get("ok") or trained.get("predictor") is None:
        err = (trained or {}).get("error", "model not trained")
        return {"ok": False, "error": err}
    try:
        import pandas as pd
        frame = pd.DataFrame([{
            "value": float(i["value"]),
            "stage": str(i.get("stage") or ""),
            "company_type": str(i.get("company_type") or ""),
            "source": str(i.get("source") or ""),
            "days_open": int(i.get("days_open") or 0),
            "activities_count": int(i.get("activities_count") or 0),
        } for i in infos])
        proba = trained["predictor"].predict_proba(frame)
        key = _positive_col(proba)
        return {"ok": True, "probabilities": [round(float(v), 4) for v in proba[key].tolist()],
                "model": "mitra"}
    except Exception as e:
        return {"ok": False, "error": f"mitra predict failed: {str(e)[:200]}"}


def predict_mitra(info, trained):
    """P(won) for one deal feature dict using a trained Mitra predictor."""
    if not trained or not trained.get("ok") or trained.get("predictor") is None:
        err = (trained or {}).get("error", "model not trained")
        return {"ok": False, "error": err}
    try:
        import pandas as pd
        frame = pd.DataFrame([{
            "value": float(info["value"]),
            "stage": str(info.get("stage") or ""),
            "company_type": str(info.get("company_type") or ""),
            "source": str(info.get("source") or ""),
            "days_open": int(info.get("days_open") or 0),
            "activities_count": int(info.get("activities_count") or 0),
        }])
        proba = trained["predictor"].predict_proba(frame)
        return {"ok": True, "probability": round(float(proba[_positive_col(proba)].iloc[0]), 4),
                "model": "mitra"}
    except Exception as e:
        return {"ok": False, "error": f"mitra predict failed: {str(e)[:200]}"}
