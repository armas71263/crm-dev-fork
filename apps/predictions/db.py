"""Tenant-scoped queries: connect as app_role via the Supabase session pooler,
set the tenant GUC per connection (RLS is the isolation boundary)."""
import os
import psycopg

DSN = os.environ.get("SUPABASE_DB_SESSION_POOLER_URL")


def tenant_query(tenant_id, sql, params=None):
    if not DSN:
        raise RuntimeError("SUPABASE_DB_SESSION_POOLER_URL is not configured")
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.tenant_id', %s, false)", (tenant_id,))
            cur.execute(sql, params)
            if cur.description is None:
                return []
            cols = [c.name for c in cur.description]
            return [dict(zip(cols, row)) for row in cur.fetchall()]
