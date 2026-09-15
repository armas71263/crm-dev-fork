"""Win-probability model tests: deterministic corpus, sane training,
monotonic behavior in the features that matter."""
import test_forecaster  # noqa: F401  (keeps the runner discovering both files)
from winprob import train, predict


def make_rows(n=150, seed=7):
    import random
    random.seed(seed)
    stages = ["qualification", "proposal", "negotiation"]
    ctypes = ["customer", "prospect", "partner"]
    sources = ["referral", "outbound", "inbound"]
    rows = []
    for i in range(n):
        r = {
            "value": 5000 + random.random() * 195000,
            "stage": stages[i % 3],
            "company_type": ctypes[i % 3],
            "source": sources[i % 3],
            "days_open": int(5 + random.random() * 175),
            "activities_count": int(1 + random.random() * 29),
        }
        z = (0.9 * r["activities_count"] / 10.0 - 0.7 * r["days_open"] / 60.0
             - 0.8 * r["value"] / 100000.0
             + (0.7 if r["stage"] == "proposal" else 1.3 if r["stage"] == "negotiation" else 0.0)
             + 0.4 * (0.8 if r["company_type"] == "customer" else 0.1 if r["company_type"] == "prospect" else 0.5)
             + 0.5 * (0.7 if r["source"] == "referral" else 0.2 if r["source"] == "inbound" else 0.0))
        r["won"] = random.random() < 1 / (1 + pow(2.718281828, -z))
        rows.append(r)
    return rows


def test_train_and_predict():
    t = train(make_rows())
    assert t["ok"]
    assert t["n"] == 150
    assert t["accuracy"] > 0.6, "the baked-in signal must be learnable"
    info = {"value": 50000, "stage": "negotiation", "company_type": "customer",
            "source": "referral", "days_open": 10, "activities_count": 20}
    p = predict(info, t)
    assert p["ok"]
    assert 0 < p["probability"] < 1


def test_monotonic_directions():
    t = train(make_rows())
    strong = predict({"value": 30000, "stage": "negotiation", "company_type": "customer",
                      "source": "referral", "days_open": 7, "activities_count": 25}, t)["probability"]
    weak = predict({"value": 190000, "stage": "qualification", "company_type": "prospect",
                    "source": "outbound", "days_open": 170, "activities_count": 2}, t)["probability"]
    assert strong > weak, "more activities / later stage / smaller deal => higher win probability"
    assert strong > 0.5 and weak < 0.5, "clear-cut deals must land on the expected side"
