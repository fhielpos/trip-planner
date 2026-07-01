# Improvements

Deferred ideas and known limitations we've chosen not to build yet. Each entry: what it is, why it matters, and a sketch of the approach.

## Import / Export

### Harden import security
`POST /api/import` is currently protected only by the global `APP_PASSWORD` basic auth — if that env var isn't set, the endpoint is open. Import is a full overwrite, which makes it a higher-risk operation than the read/write endpoints.

Options considered:
- **Always require basic auth for import** — force the user to set `APP_PASSWORD` before the endpoint responds, even if the rest of the app is unprotected.
- **Separate `IMPORT_TOKEN` header** — a dedicated env var that must be sent as `X-Import-Token` on every import request, independent of the main app password.
- **Backup before overwrite** — before writing, snapshot the current data files so a mistaken import can be rolled back. Could be as simple as writing to `data/backup-YYYY-MM-DD.json` on each import call.

## Budget

### Warn when sub-budget caps exceed the global budget
Sub-budget caps and `initialBudget` are decoupled — you can allocate caps totalling more than the global budget (e.g. Food 6,000 + Shopping 3,000 + Activities 2,500 = 11,500 against a 10,000 budget) and the tool accepts it silently.

Not necessarily a bug: over-allocating on purpose is valid (you expect to underspend some categories). But there's currently no signal.

Possible approach (non-blocking, no data-model change):
- Live "Allocated X / Y" readout in the settings modal, turning red when over.
- Same summary on the displayed sub-budget block, so the unallocated remainder is always visible.

Avoid a hard block on save — a warning is friendlier and preserves intentional over-allocation.
