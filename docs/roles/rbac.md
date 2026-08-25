# Roles (RBAC) — Who Can Do What

RBAC = Role-Based Access Control. We use Directus permissions layered on top of Postgres RLS.

## The roles to create

| Role | Description | Access |
|------|-------------|--------|
| `privileged-admin` | **You** (the platform creator) | Full access to everything including Directus system settings, templates, and all tenants. |
| `tenant-admin` | **Client's main admin** | Full access to their tenant; Directus admin UI incl. collections, users, roles (guarded, no system) |
| `staff-sales` | Client's sales team | Table + card screens; CRUD own records, view customers |
| `staff-logistics` | Client's operations team | Table screens + tracking/pending docs checklists |
| `staff-documentation` | Docs handling | Doc checker, Diffchecker, files |
| `staff-technical` | Tech support | Tickets flow, settings (within tenant) |
| `customer` | **External client of your client** | Own company records/documents/issues (read + comment/upload) — login with invite |

## Unrestricted-role access

There's NO role like that. Everything is tenant-scoped. `privileged-admin` is max-privilege but still bound to a specific tenant context (or "all context" by design).

## Destroyable-level safety

- RLS and presets allow `tenant-admin` to curate roles in their own tenant.
- The `privileged-admin` can modify the template but template changes don't suddenly re-shape flagged clients.

## Logging examples (implemented per role)

| Log | Who sees it |
|-----|-------------|
| AI usage logs (embeddings, calls, costs) | tenant-admin |
| Audit logs (row changes, login, UI access) | tenant-admin + privileged-admin |
| Tenant scale (RLS bypass attempts) | privileged-admin |
