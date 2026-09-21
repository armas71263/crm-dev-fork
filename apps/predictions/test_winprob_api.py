"""Endpoint contract: Logit stays the default; Mitra is opt-in challenger.

POST /win-probability {deal_id} -> logit (unchanged shape + model.name).
POST /win-probability {deal_id, model: "mitra"} -> mitra, or logit fallback.
GET /win-probability/model -> logit payload + challenger status block.
"""
import sys

sys.path.insert(0, ".")

import main
from fastapi.testclient import TestClient

import random as _random
_random.seed(11)
_STAGES = ["qualification", "proposal", "negotiation"]
_CTYPES = ["customer", "prospect", "partner"]
_SOURCES = ["referral", "outbound", "inbound"]
CORPUS = []
for _i in range(80):
    _r = {
        "value": 5000 + _random.random() * 195000,
        "stage": _STAGES[_i % 3],
        "company_type": _CTYPES[(_i + 1) % 3],
        "source": _SOURCES[(_i + 2) % 3],
        "days_open": int(5 + _random.random() * 175),
        "activities_count": int(1 + _random.random() * 29),
    }
    _z = (0.9 * _r["activities_count"] / 10.0 - 0.7 * _r["days_open"] / 60.0
          - 0.8 * _r["value"] / 100000.0)
    _r["won"] = _random.random() < 1 / (1 + pow(2.718281828, -_z))
    CORPUS.append(_r)

DEAL = {"name": "Big Deal", "value": 50000.0, "stage": "negotiation",
        "company_type": "customer", "source": "referral",
        "days_open": 10, "activities_count": 8}


def _fake_tenant_query(tenant, sql, params=None):
    if "FROM deal_history" in sql:
        return [dict(r) for r in CORPUS]
    if "FROM deals d" in sql:
        return [dict(DEAL)]
    raise AssertionError(f"unexpected sql: {sql[:60]}")


def _client(monkeypatch, mitra_env=None):
    monkeypatch.setattr(main, "tenant_query", _fake_tenant_query)
    main._WINPROB_CACHE.clear()
    main._MITRA_CACHE.clear()
    if mitra_env is None:
        monkeypatch.delenv("PREDICTIONS_USE_MITRA", raising=False)
    else:
        monkeypatch.setenv("PREDICTIONS_USE_MITRA", mitra_env)
    return TestClient(main.app)


def test_post_defaults_to_logit(monkeypatch):
    c = _client(monkeypatch)
    r = c.post("/win-probability", json={"deal_id": 1},
               headers={"x-tenant-id": "t1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert 0 < body["probability"] < 1
    assert body["model"]["name"] == "logit"


def test_post_mitra_falls_back_when_disabled(monkeypatch):
    c = _client(monkeypatch)
    r = c.post("/win-probability", json={"deal_id": 1, "model": "mitra"},
               headers={"x-tenant-id": "t1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["model"]["name"] == "logit"
    assert "fallback" in body["model"]


def test_post_mitra_when_stubbed(monkeypatch):
    c = _client(monkeypatch, mitra_env="1")
    monkeypatch.setattr(main, "mitra_available", lambda: True)
    monkeypatch.setattr(main, "train_mitra",
                        lambda rows: {"ok": True, "model": "mitra",
                                      "n": len(rows), "predictor": object(),
                                      "accuracy": 0.8})
    monkeypatch.setattr(main, "batch_predict_mitra",
                        lambda infos, t: {"ok": True, "probabilities": [0.62],
                                          "model": "mitra"})
    r = c.post("/win-probability", json={"deal_id": 1, "model": "mitra"},
               headers={"x-tenant-id": "t1"})
    assert r.status_code == 200
    body = r.json()
    assert body["probability"] == 0.62
    assert body["model"]["name"] == "mitra"


def test_post_mitra_train_failure_falls_back(monkeypatch):
    c = _client(monkeypatch, mitra_env="1")
    monkeypatch.setattr(main, "mitra_available", lambda: True)
    monkeypatch.setattr(main, "train_mitra",
                        lambda rows: {"ok": False, "error": "boom"})
    r = c.post("/win-probability", json={"deal_id": 1, "model": "mitra"},
               headers={"x-tenant-id": "t1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["model"]["name"] == "logit"
    assert "fallback" in body["model"]


def test_model_endpoint_reports_challenger(monkeypatch):
    c = _client(monkeypatch)
    r = c.get("/win-probability/model", headers={"x-tenant-id": "t1"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "coef" in body  # logit payload unchanged
    assert body["challenger"]["ok"] is False  # flag off here
