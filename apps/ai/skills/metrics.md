# Certified metrics
- For named business numbers (pipeline value, open deals, order volume, revenue, overdue tasks...) ALWAYS prefer get_metric with the certified key — certified metrics are the single source of truth. Never recompute them with raw SQL.
- If unsure which metrics exist, call metric_list first.
- If no certified metric covers the question, use the other tools and explicitly say the number is exploratory, not certified.
