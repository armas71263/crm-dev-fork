"""Mitra challenger contract tests: gating, fallback, and stubbed predict.

Real Mitra fits need ~7GB + GPU and never run in unit tests — these pin the
opt-in contract (flag-gated, Logit stays default, failures fall back cleanly).
"""
import importlib
import os
import sys

sys.path.insert(0, ".")


def _reload_mitra(env_val):
    if env_val is None:
        os.environ.pop("PREDICTIONS_USE_MITRA", None)
    else:
        os.environ["PREDICTIONS_USE_MITRA"] = env_val
    import mitra_winprob
    return importlib.reload(mitra_winprob)


def test_gated_off_by_default():
    m = _reload_mitra(None)
    assert m.mitra_available() is False


def test_gated_off_explicit_zero():
    m = _reload_mitra("0")
    assert m.mitra_available() is False


def test_train_refuses_when_gated_off():
    m = _reload_mitra(None)
    out = m.train_mitra([{"value": 1, "stage": "proposal", "company_type": "customer",
                           "source": "referral", "days_open": 5, "activities_count": 3,
                           "won": True}])
    assert out["ok"] is False
    assert "MITRA" in out["error"] or "mitra" in out["error"].lower()


def test_predict_passes_through_training_failure():
    m = _reload_mitra(None)
    bad = {"ok": False, "error": "disabled"}
    out = m.predict_mitra({"value": 1, "stage": "proposal", "company_type": "customer",
                            "source": "referral", "days_open": 5, "activities_count": 3}, bad)
    assert out["ok"] is False


def test_predict_contract_with_stubbed_predictor(monkeypatch):
    """A stubbed AutoGluon predictor proves the row<->frame wiring without weights."""
    m = _reload_mitra("1")

    class FakePredictor:
        def __init__(self, *a, **k):
            pass

        def fit(self, *a, **k):
            return self

        def predict_proba(self, frame):
            import pandas as pd
            return pd.DataFrame({0: [0.3] * len(frame), 1: [0.7] * len(frame)})

        def predict(self, frame):
            return [1] * len(frame)

    import pandas as pd
    monkeypatch.setitem(sys.modules, "autogluon.tabular",
                        type("M", (), {"TabularDataset": lambda df: df,
                                       "TabularPredictor": FakePredictor})())
    rows = [{"value": 50000, "stage": "negotiation", "company_type": "customer",
             "source": "referral", "days_open": 10, "activities_count": 8, "won": True},
            {"value": 90000, "stage": "qualification", "company_type": "prospect",
             "source": "outbound", "days_open": 90, "activities_count": 1, "won": False}]
    t = m.train_mitra(rows, _predictor_cls=FakePredictor,
                      _dataset_fn=lambda df: df)
    assert t["ok"] is True
    assert t["model"] == "mitra"
    assert t["n"] == 2
    p = m.predict_mitra({"value": 50000, "stage": "negotiation", "company_type": "customer",
                         "source": "referral", "days_open": 10, "activities_count": 8}, t)
    assert p["ok"] is True
    assert p["probability"] == 0.7
    assert p["model"] == "mitra"


def test_single_class_corpus_rejected():
    m = _reload_mitra("1")
    rows = [{"value": 1, "stage": "proposal", "company_type": "customer",
             "source": "referral", "days_open": 5, "activities_count": 3, "won": True}
            for _ in range(5)]
    out = m.train_mitra(rows, _predictor_cls=None, _dataset_fn=None,
                        _skip_fit=True)
    assert out["ok"] is False
    assert "single class" in out["error"]


def test_holdout_accuracy_with_stubbed_predictor():
    m = _reload_mitra("1")

    class AccPredictor:
        # rows carry won = (value even); the helper passes features only.
        def predict_proba(self, frame):
            import pandas as pd
            even = [(int(v) % 2 == 0) for v in frame["value"].tolist()]
            return pd.DataFrame({0: [0.2 if w else 0.8 for w in even],
                                 1: [0.8 if w else 0.2 for w in even]})

    rows = [{"value": 50000 + i, "stage": "negotiation", "company_type": "customer",
             "source": "referral", "days_open": 10, "activities_count": 8, "won": i % 2 == 0}
            for i in range(6)]
    trained = {"ok": True, "model": "mitra", "n": 6, "predictor": AccPredictor()}
    assert m.holdout_accuracy(trained, rows) == 1.0


def test_batch_predict_single_pass():
    m = _reload_mitra("1")

    class BatchPredictor:
        def __init__(self):
            self.calls = 0

        def predict_proba(self, frame):
            import pandas as pd
            self.calls += 1
            return pd.DataFrame({0: [0.3] * len(frame), 1: [0.7] * len(frame)})

    pred = BatchPredictor()
    infos = [{"value": 50000, "stage": "negotiation", "company_type": "customer",
              "source": "referral", "days_open": 10, "activities_count": 8} for _ in range(3)]
    out = m.batch_predict_mitra(infos, {"ok": True, "predictor": pred})
    assert out == {"ok": True, "probabilities": [0.7, 0.7, 0.7], "model": "mitra"}
    assert pred.calls == 1
