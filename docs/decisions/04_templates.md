# Decision 4: Which Client Templates We Start With

## What's a "template" (and why you need it)

Since you're selling this to many clients, you need a way to deploy a new client in minutes — not weeks. A **template** = a shippable data+UI preset that gets cloned when onboarding a new client.

Templates define:

- **Collections** (tables/entities) with their schemas.
- **Pre-configured layouts/screens** (table view vs card view vs lists).
- **KPI definitions & chart configs**.
- **Screens to install** (e.g., "Document Checker" for trading). 
- **Roles and permissions**.
- **Seed data** (sample records).

## "Schemas" vs "template" — two different things

1. **Schema** = the data shape (e.g., "orders have date, customer, grade, volume").
2. **Template** = the schema + UI + screening hints + sample data + onboarding script — the whole setup.

## Initial templates recommended

### 1. RubberTrack — the demo/example client template

This replicates what your Figma shows and becomes the sales-demo template for trade-grade/goods clients (rubber, chemicals, agriculture etc.). Anyone can see what the platform can do.

- Collections: `records`, `parties` (customers/suppliers), `tickets`, `hr_events`, `feed_items`, `checklists`, `files`
- Screens: table record view, cards for parties, ticket lists, assistant, insights, doc checker, diff checker
- KPI preset: volume MT, orders count, grade mix, issues open, ISO expiry countdown
- Demo data: seeded with the Figma sample values

### 2. Generic Services template (optional but recommended)

A clean template for service businesses (consulting, agencies, clinics, logistics services). Use-case: clients who don't have the trading/order-pattern.

- Collections: `parties` (customers, vendors), `tickets` (service requests), `feed_items` (posts/docs), `checklists`
- Screens: table + card party pages, tickets flow, feed with categories, assistant
- KPI preset: open tickets, ticket volume by status, clients count, deadlines

### Optional later: retail/inventory template

If a client later needs product/SKU-based analytics, we create a "retail" template with different schema (products, stock, sales).

## What onboarding a new client does (concrete)

Example: onboarding "Biryani B2C Foods" (a restaurant chain):

1. User clicks "Create tenant → Clone RubberTrade template".
2. Script creates:
   - schema with collections,
   - menu/screening config (record table, cards, charts),
   - `tenant-admin` role for client with access to admin UI,
   - `staff-sales` & `staff-logistics` roles,
   - seed data optional (sample/demo or skip).
3. Tenant is live, isolated (RLS policy) — this happens in under a minute.

## Tenant label config (their own business language)

Clients can rename the modules:
- `records` → they might rename to "Orders"
- `parties` → "Clients & Suppliers"
- `tickets` → "Service Calls"

This is simply a label stored per client; the schema stays the same.

## What the privileged-client admin can customize safely

| Customization | In scope |
|---------------|----------|
| Add/remove fields in collections | ✅ via Directus admin (guarded) |
| Add/remove screens, filters, labels | ✅ via screen-config editor |
| Add/edit roles & permissions | ✅ within their tenant |
| Schema change that would affect other tenants | ❌ restricted (only you) |

**Decision question**: Do we launch with **only the RubberTrack template** or with **RubberTrack + generic Services template**? (I recommend both but RubberTrack alone is your demo client). Approve RobotTrack + generic Services? (Yes/No)
