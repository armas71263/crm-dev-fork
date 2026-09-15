"""Forecastable series definitions (SQL is server-side, RLS-scoped)."""

SERIES = {
    "record_mt": {
        "label": "Monthly order volume (MT)",
        "sql": "SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS m, sum(mt)::float AS v "
               "FROM records GROUP BY 1 ORDER BY 1",
    },
    "deal_value": {
        "label": "Monthly deal value (USD)",
        "sql": "SELECT to_char(date_trunc('month', coalesce(expected_close_date, created_at)), 'YYYY-MM') AS m, "
               "sum(value)::float AS v FROM deals GROUP BY 1 ORDER BY 1",
    },
}
