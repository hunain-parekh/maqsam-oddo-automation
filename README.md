# Maqsam to Odoo CRM Automation

This starter syncs Maqsam call records into Odoo CRM leads.

The recommended runtime is:

1. n8n `Schedule Trigger` runs every hour.
2. n8n runs `node src/sync-maqsam-odoo.js`.
3. The script calls Maqsam `GET /v2/calls` with `start_time`, `end_time`, and `page`.
4. The script dedupes calls, creates Odoo `crm.lead` records, then advances `data/state.json`.

The state is advanced only after all new calls are successfully pushed to Odoo. If Odoo fails, the next run retries the same time window.

## Maqsam API Behavior Used

Maqsam Calls API V2 uses HTTP Basic Authentication:

```bash
curl -u "<access_key_id>:<access_secret>" "https://api.<base_url>/v2/calls"
```

The index endpoint supports:

- `start_time`: Unix timestamp; calls created after or at this time.
- `end_time`: Unix timestamp; calls created before or at this time.
- `page`: positive integer.

Each page returns up to 100 call records, so the script keeps paging until a page returns fewer than 100 records.

## Odoo Setup

Use the Odoo API key you already created as `ODOO_API_KEY`.

Recommended Odoo custom field:

- Model: `crm.lead`
- Field name: `x_maqsam_call_id`
- Type: Char

This gives Odoo-side dedupe. Without it, the script still dedupes using `data/state.json`, but a lost state file could cause duplicate leads.

## Local Setup

Copy the example environment file:

```bash
cp .env.example .env
```

Fill in:

```bash
MAQSAM_BASE_URL=
MAQSAM_ACCESS_KEY_ID=
MAQSAM_ACCESS_SECRET=
ODOO_URL=
ODOO_DB=
ODOO_USERNAME=
ODOO_API_KEY=
```

Run a syntax check:

```bash
npm run check
```

Run a dry run:

```bash
npm run sync:dry-run
```

Run the real sync:

```bash
npm run sync
```

## n8n Setup

For n8n Cloud, read [docs/n8n-cloud.md](docs/n8n-cloud.md). The workflow JSON below is for self-hosted n8n only because it uses the `Execute Command` node.

For EC2 deployment with an hourly `systemd` timer, read [docs/ec2-deploy.md](docs/ec2-deploy.md).

Option A: import the starter workflow:

```text
n8n/maqsam-odoo-hourly-workflow.json
```

Then update the `Run Maqsam Odoo Sync` command if your n8n instance sees this project at a different filesystem path.

Option B: create it manually:

1. Add a `Schedule Trigger`.
2. Set interval to `Hours`, every `1` hour, at minute `0`.
3. Add an `Execute Command` node.
4. Use:

```bash
cd /Users/macbookpro/Desktop/Code/maqsam-oddo-automation && node src/sync-maqsam-odoo.js
```

5. Publish/activate the workflow.

If n8n runs in Docker, mount this project into the n8n container and adjust the command path to the path inside the container.

## State Logic

The state file stores:

- `lastSuccessfulEndTime`: the last fully completed Maqsam window.
- `processedCallIds`: recently processed Maqsam call IDs.

On each run:

1. First run fetches the latest Maqsam page without date filters, up to 100 calls by default.
2. Later runs start at `lastSuccessfulEndTime - SYNC_OVERLAP_SECONDS`.
3. Already processed call IDs are skipped.
4. Odoo is checked for `x_maqsam_call_id` when configured.
5. `lastSuccessfulEndTime` advances only when every new call succeeds.

The overlap helps catch records that appear slightly late in Maqsam.

Dry runs never update `data/state.json`.

## Useful Configuration

```bash
# First run imports latest page 1 from Maqsam, up to 100 calls.
SYNC_FIRST_RUN_MODE=latest_page
SYNC_INITIAL_IMPORT_PAGES=1

# Used only if SYNC_FIRST_RUN_MODE=lookback.
SYNC_INITIAL_LOOKBACK_SECONDS=86400
SYNC_OVERLAP_SECONDS=300
SYNC_END_DELAY_SECONDS=60
SYNC_MAX_PAGES=100
SYNC_PROCESSED_ID_RETENTION_SECONDS=604800
```

Optional Odoo assignment:

```bash
ODOO_TEAM_ID=1
ODOO_USER_ID=7
```

## Notes

- Keep `.env` private. Do not commit real API keys.
- If you change the custom field name in Odoo, update `ODOO_MAQSAM_ID_FIELD`.
- If `ODOO_MAQSAM_ID_FIELD` is set but the field does not exist in Odoo, lead creation/search will fail.
