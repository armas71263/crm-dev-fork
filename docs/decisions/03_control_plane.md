# Decision 3: What Directus Does (admin panel, login, permissions, API)

## What Directus is (in plain words)

Directus is an **open-source "data studio in a box"**. You point it to a database, and it gives you:

1. A ready **admin UI** (add/edit/view data — no coding).
2. A ready **API** (REST + GraphQL for your app).
3. Ready **authentication** (email/password login, tokens).
4. Ready **role-based permissions** (RBAC).
5. Ready **file storage** (uploads).

Instead of coding all of that from scratch (2–4 weeks of work), we run one Docker container and it's live.

## Why this matters for your multi-clients model

- **New client setup (RubberTrack vs. anything else)**: You log into Directus, define that client's collections (tables) and roles. No code changes needed.
- **New role or permission**: Set role + collection + field rules in the UI (e.g., "customers can only see their own orders").
- **Admin UI out of the box**: The privileged-admin (you) and tenant admins get a full back office with no coding.

## How Directus + your custom frontend work together

- **Frontend** (your custom React screens) uses Directus SDK/API for all data.
- **Directus admin UI** runs on the same backend but is accessible ONLY to `privileged-admin` and `tenant-admin` roles.
- Custom screens (Dashboard, AI panel, Doc checker) stay custom React; the underlying data still flows through Directus.

## How it'll look (sets of screens)

**For you (privileged-admin)** and **tenant-admin**:
- Directus Admin UI at `https://api.yourapp.com/admin` — collections, users, roles, settings, files.

**For staff + customers**:
- Your custom React app (the beautiful Figma-designed interface).
- They never see Directus. They see your pretty dashboard.

## Security (who gets Directus admin)

| Role | Directus admin UI access? |
|---|---|
| `privileged-admin` (you) | ✅ Full |
| `tenant-admin` (client's admin) | ✅ Full |
| `staff-*` (staff roles) | ❌ No (custom app only) |
| `customer` (external client) | ❌ No (custom app only) |

We remove admin UI access for staff/customer to prevent them from bypassing your custom business logic.

## What Directus will NOT do

- It doesn't build your custom dashboard, charts, AI assistant, or document checker UIs.
- It doesn't do your specific business logic workflows (like order pipeline states) — those live in the custom frontend.
- It doesn't intentionally allow cross-tenant access — that's enforced via Postgres RLS (Decision 1).

## The hardware/deployment

- Runs as 1 Docker container in your compose.
- Connects to Supabase Postgres (or Neon — works either way).
- Directus v12+ — current active project with good versioning.

## Alternatives considered

| Option | Why we chose Directus |
|---|---|
| NestJS API from scratch | More code, full control — we can still do this later if needed |
| Payload CMS (headless) | Since Directus already gives admin UI + API + RBAC |
| Hasura | GraphQL-first; less extensible for admin UI |

**Decision question**: Approve Directus as the admin UI + API + RBAC + auth, alongside custom React frontend for user-facing screens? (Yes/No)
