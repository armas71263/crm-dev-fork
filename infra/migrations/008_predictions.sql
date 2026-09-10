-- 008: Predictions (Phase 5) — stored forecasts per tenant+series, plus a
-- synthetic 24-month order history for the rubbertrack demo tenant so the
-- forecaster has a real series to learn from (idempotent).

CREATE TABLE IF NOT EXISTS predictions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES app.tenants(id),
  series       TEXT NOT NULL,
  model        TEXT NOT NULL,
  horizon      INT NOT NULL,
  history      JSONB NOT NULL DEFAULT '[]',
  forecast     JSONB NOT NULL DEFAULT '[]',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, series)
);

ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON predictions;
CREATE POLICY tenant_isolation ON predictions
  FOR ALL TO public
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

GRANT SELECT, INSERT, UPDATE ON predictions TO app_role;

-- Synthetic monthly history: 23 months x 3 orders, deterministic values with a
-- seasonal wave so the forecast has a learnable pattern. Skipped if present.
INSERT INTO records (tenant_id, order_id, date, customer, supplier, grade, mt, fcl, price_usd, status)
SELECT 'rubbertrack',
       'ORD-HIST-' || to_char(d, 'YYYY-MM') || '-' || g,
       d + (g * interval '3 day'),
       (ARRAY['JK Tyre','MRF','CEAT','Apollo Tyres','BKT'])[1 + ((i * 7 + g * 3) % 5)],
       (ARRAY['Tiong Huat','SMR Indonesia','SICOM','Von Bundit'])[1 + ((i * 5 + g) % 4)],
       (ARRAY['TSR-20','RSS-3','SVR-3L','Latex'])[1 + ((i + g) % 4)],
       round((240 + 45 * sin(i / 3.2) + 14 * g + (i % 5) * 3)::numeric, 1),
       2 + (i % 3),
       1700 + ((i * 37 + g * 111) % 350),
       'Delivered'
FROM generate_series(
       date_trunc('month', current_date) - interval '24 months',
       date_trunc('month', current_date) - interval '2 months',
       interval '1 month') WITH ORDINALITY AS t(d, i)
CROSS JOIN generate_series(0, 2) AS g(g)
WHERE NOT EXISTS (SELECT 1 FROM records WHERE tenant_id = 'rubbertrack' AND order_id LIKE 'ORD-HIST-%');
