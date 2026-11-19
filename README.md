# Flipkart Seller Manager

Personal Flipkart seller operations system.

## Stack

- Next.js 16
- Vercel
- Supabase Postgres + Auth
- Flipkart Self Access API

## Current implementation

The application is a working seller operations dashboard backed by live Flipkart data in Supabase.

Implemented:

- Flipkart OAuth client-credentials authentication
- Shipment filter sync with incremental windows and pagination
- Shipment detail enrichment
- Listing/catalogue sync
- Inventory and pricing persistence
- Product enrichment fallback handling
- Returns sync
- Flipkart order notifications with signature verification and duplicate protection
- Shipment and return event processing
- Shipment labels, invoices, and forms retrieval
- Sync-run persistence, checkpoints, and concurrency protection
- Raw Flipkart payload retention for debugging and schema evolution
- Authenticated seller dashboard for orders, listings, shipments, returns, inventory, and sync health

## Current limitations

This is not yet a full seller execution console.

Not implemented yet:

- Listing create/update mutations
- Inventory write APIs
- Price write APIs
- Shipment pack/label generation mutations
- Shipment dispatch/cancel actions
- Self-ship dispatch/delivery actions
- Return approval/rejection/completion actions
- Handover/manifest workflows
- Report Management API integration

Reports are intentionally not implemented in the current Self Access integration because Flipkart documents the Reports API as a paid service accessible only through third-party partner tokens.

## Security

- Flipkart credentials and Supabase service-role credentials remain server-side.
- Never prefix secrets with `NEXT_PUBLIC_`.
- Application routes require the authenticated seller account or a server-only sync secret.
- Supabase tables have RLS policies scoped to `auth.uid()`.

## Known engineering follow-ups

1. Complete end-to-end validation of shipment detail response handling against live Flipkart responses.
2. Add mutation APIs only after each request/response contract is verified against the current Flipkart documentation.
3. Add automated tests and CI. The repository currently has no test runner or GitHub Actions workflow.
4. Add database migrations/schema to the repository so Supabase can be reproduced from source.
5. Enable Supabase leaked-password protection.
6. Review the 33 currently unused indexes against real query plans before removing any.
