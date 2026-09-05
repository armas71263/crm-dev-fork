// Generic CRM routes — companies, contacts, leads, deals, activities + pipeline
// config. One factory drives all entities: column allowlists (never client SQL),
// tenant from the RLS session (never the body), audit_logs on every mutation.
// Cross-tenant ids simply match 0 rows under RLS → 404.

const ENTITIES = {
  companies: {
    table: 'companies', singular: 'company',
    columns: ['name', 'type', 'industry', 'website', 'phone', 'email', 'address', 'notes', 'status', 'owner_id'],
    required: ['name'],
    search: ['name', 'industry', 'notes'],
    orderBy: 'name',
    filters: { type: 'type', status: 'status' },
  },
  contacts: {
    table: 'contacts', singular: 'contact',
    columns: ['company_id', 'full_name', 'first_name', 'last_name', 'title', 'email', 'phone', 'mobile', 'linkedin', 'status', 'owner_id'],
    required: ['full_name'],
    search: ['full_name', 'email', 'title'],
    orderBy: 'full_name',
    filters: { company_id: 'company_id', status: 'status' },
  },
  leads: {
    table: 'leads', singular: 'lead',
    columns: ['name', 'company_name', 'contact_name', 'email', 'phone', 'source', 'value', 'status', 'owner_id'],
    required: ['name'],
    search: ['name', 'company_name', 'contact_name', 'email'],
    orderBy: 'created_at DESC',
    filters: { status: 'status' },
  },
  deals: {
    table: 'deals', singular: 'deal',
    columns: ['name', 'company_id', 'contact_id', 'lead_id', 'stage', 'value', 'currency', 'expected_close_date', 'probability', 'status', 'owner_id'],
    required: ['name', 'stage'],
    search: ['name'],
    orderBy: 'created_at DESC',
    filters: { stage: 'stage', status: 'status', company_id: 'company_id' },
  },
  activities: {
    table: 'activities', singular: 'activity',
    columns: ['type', 'subject', 'detail', 'entity', 'entity_id', 'due_at', 'completed', 'user_id'],
    required: ['subject'],
    search: ['subject', 'detail'],
    orderBy: 'created_at DESC',
    filters: { type: 'type', entity: 'entity', entity_id: 'entity_id', completed: 'completed' },
  },
}

const LIMIT = 200

function pickAllowlisted(body, columns) {
  const out = {}
  for (const c of columns) if (body[c] !== undefined) out[c] = body[c]
  return out
}

export function registerCrmRoutes(fastify, { tenantQuery, writeAudit }) {
  for (const [name, def] of Object.entries(ENTITIES)) {
    const { table, singular, columns, required, search, orderBy, filters } = def

    fastify.get(`/data/crm/${name}`, async (req) => {
      const where = []
      const params = []
      const q = req.query || {}
      if (q.search && search.length) {
        where.push(`(${search.map((c) => `${c} ILIKE $${params.length + 1}`).join(' OR ')})`)
        params.push(`%${q.search}%`)
      }
      for (const [qp, col] of Object.entries(filters)) {
        let v = q[qp]
        if (v === undefined || v === '') continue
        if (['company_id', 'entity_id', 'lead_id', 'contact_id'].includes(qp)) {
          const n = parseInt(v, 10)
          if (!Number.isFinite(n)) continue
          v = n
        }
        if (qp === 'completed') v = v === 'true' || v === '1'
        where.push(`${col} = $${params.length + 1}`)
        params.push(v)
      }
      const sql = `SELECT id, ${columns.join(', ')}, extra, created_at FROM ${table}`
        + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
        + ` ORDER BY ${orderBy} LIMIT ${LIMIT}`
      const r = await tenantQuery(req, sql, params)
      return { [name]: r.rows }
    })

    fastify.get(`/data/crm/${name}/:id`, async (req, reply) => {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad id' })
      const r = await tenantQuery(req,
        `SELECT id, ${columns.join(', ')}, extra, created_at FROM ${table} WHERE id = $1`, [id])
      if (!r.rows.length) return reply.code(404).send({ error: 'not found' })
      return { [singular]: r.rows[0] }
    })

    fastify.post(`/data/crm/${name}`, async (req, reply) => {
      const body = req.body || {}
      const missing = required.filter((f) => body[f] === undefined || body[f] === '')
      if (missing.length) return reply.code(400).send({ error: `missing required field(s): ${missing.join(', ')}` })
      const fields = pickAllowlisted(body, columns)
      const cols = Object.keys(fields)
      const extra = (body.extra && typeof body.extra === 'object' && !Array.isArray(body.extra)) ? body.extra : {}
      const all = [...cols, 'extra']
      const placeholders = all.map((c, i) => c === 'extra' ? `$${i + 1}::jsonb` : `$${i + 1}`).join(', ')
      const values = [...cols.map((c) => fields[c]), JSON.stringify(extra)]
      const r = await tenantQuery(req,
        `INSERT INTO ${table} (tenant_id, ${all.join(', ')}) VALUES (app.current_tenant(), ${placeholders}) RETURNING *`,
        values)
      await writeAudit(req, 'create', table, r.rows[0]?.id, { name: body[`${singular}_name`] || body.name })
      return reply.code(201).send({ [singular]: r.rows[0] })
    })

    fastify.patch(`/data/crm/${name}/:id`, async (req, reply) => {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad id' })
      const fields = pickAllowlisted(req.body || {}, columns)
      const keys = Object.keys(fields)
      if (!keys.length) return reply.code(400).send({ error: 'no allowlisted fields to update' })
      const sets = keys.map((c, i) => `${c} = $${i + 1}`).join(', ')
      const params = [...keys.map((c) => fields[c]), id]
      const r = await tenantQuery(req,
        `UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`, params)
      if (!r.rows.length) return reply.code(404).send({ error: 'not found' })
      await writeAudit(req, 'update', table, id, { fields: keys })
      return { [singular]: r.rows[0] }
    })

    fastify.delete(`/data/crm/${name}/:id`, async (req, reply) => {
      const id = parseInt(req.params.id, 10)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'bad id' })
      const r = await tenantQuery(req, `DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id])
      if (!r.rows.length) return reply.code(404).send({ error: 'not found' })
      await writeAudit(req, 'delete', table, id, {})
      return { deleted: true, id }
    })
  }

  // ---- Pipeline stages (tenant config) ----
  fastify.get('/data/crm/pipeline', async (req) => {
    const r = await tenantQuery(req,
      'SELECT key, label, position, probability, stage_type FROM pipeline_stages ORDER BY position')
    return { stages: r.rows }
  })

  fastify.put('/data/crm/pipeline', async (req, reply) => {
    const body = req.body
    if (!Array.isArray(body) || !body.length) return reply.code(400).send({ error: 'expected a non-empty array of stages' })
    for (const s of body) {
      if (!s || typeof s !== 'object' || typeof s.key !== 'string' || !s.key.trim() || typeof s.label !== 'string') {
        return reply.code(400).send({ error: 'each stage needs key and label' })
      }
    }
    await tenantQuery(req, 'DELETE FROM pipeline_stages WHERE tenant_id = app.current_tenant()')
    for (const [i, s] of body.entries()) {
      await tenantQuery(req,
        `INSERT INTO pipeline_stages (tenant_id, key, label, position, probability, stage_type)
         VALUES (app.current_tenant(), $1, $2, $3, $4, $5)`,
        [s.key, s.label, s.position ?? i + 1, s.probability ?? 0, s.stage_type || 'open'])
    }
    await writeAudit(req, 'update', 'pipeline_stages', null, { count: body.length })
    const r = await tenantQuery(req,
      'SELECT key, label, position, probability, stage_type FROM pipeline_stages ORDER BY position')
    return { stages: r.rows }
  })
}
