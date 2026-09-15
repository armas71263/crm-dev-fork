"""Win-probability model (Phase 5 completion): statsmodels Logit over the
deal_history training corpus (migration 011). Logistic regression on
purpose — interpretable coefficients a sales team can act on, zero new
dependencies, deterministic."""
import numpy as np
import statsmodels.api as sm

STAGES = {"qualification": 0.0, "proposal": 0.7, "negotiation": 1.3}
CTYPES = {"prospect": 0.1, "partner": 0.5, "customer": 0.8}
SOURCES = {"outbound": 0.0, "inbound": 0.2, "referral": 0.7}


def _features(value, stage, company_type, source, days_open, activities_count):
    return [
        float(value) / 100000.0,
        STAGES.get(stage, 0.0),
        CTYPES.get(company_type, 0.0),
        SOURCES.get(source, 0.0),
        float(days_open) / 60.0,
        float(activities_count) / 10.0,
    ]


def train(rows):
    """rows: dicts with value/stage/company_type/source/days_open/activities_count/won."""
    X = np.array([_features(r["value"], r["stage"], r["company_type"], r["source"], r["days_open"], r["activities_count"]) for r in rows])
    y = np.array([1 if r["won"] else 0 for r in rows])
    if len(set(y.tolist())) < 2:
        return {"ok": False, "error": "training corpus has a single class"}
    model = sm.Logit(y, sm.add_constant(X)).fit(disp=0)
    return {
        "ok": True,
        "model": model,
        "n": len(rows),
        "pseudo_r2": float(model.prsquared),
        "accuracy": float(((model.predict() > 0.5) == y).mean()),
        "coef": model.params.tolist(),
        "feature_names": ["const", "deal_value", "stage", "company_type", "source", "days_open", "activities_count"],
    }


def predict(info, trained):
    if not trained or not trained.get("ok"):
        return {"ok": False, "error": "model not trained"}
    x = np.array([1.0] + _features(info["value"], info["stage"], info["company_type"], info["source"], info["days_open"], info["activities_count"]))
    p = float(trained["model"].predict(x, transform=False)[0])
    return {"ok": True, "probability": round(p, 4)}
