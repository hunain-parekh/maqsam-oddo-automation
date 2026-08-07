# n8n Cloud Deployment

n8n Cloud cannot run this project as a filesystem Node.js script because the `Execute Command` node is not available on n8n Cloud.

Use one of these two approaches instead.

## Option A: Rebuild As Native n8n Cloud Workflow

This is the best option if you want everything to live inside n8n Cloud.

Create these credentials in n8n:

- Maqsam: `HTTP Basic Auth`
  - Username: Maqsam `access_key_id`
  - Password: Maqsam `access_secret`
- Odoo: `Odoo`
  - Site URL: your Odoo URL
  - Username: your Odoo username/email
  - Password or API key: your Odoo API key
  - Database: your Odoo database name

Create this workflow:

1. `Schedule Trigger`
   - Every 1 hour.
2. `Code`
   - Read workflow static data.
   - Compute `start_time` and `end_time` Unix timestamps.
3. `HTTP Request`
   - GET `https://api.<MAQSAM_BASE_URL>/v2/calls`
   - Use Maqsam Basic Auth credential.
   - Query params: `start_time`, `end_time`, `page`.
   - Enable pagination by incrementing `page`.
4. `Code`
   - Flatten `message` into individual calls.
   - Skip IDs already stored in workflow static data.
   - Map each call into an Odoo opportunity payload.
5. `Odoo`
   - Use the Odoo credential.
   - Resource: `Opportunity` or `Custom Resource`.
   - Operation: `Create`.
6. `Code`
   - After Odoo succeeds, store processed Maqsam IDs.
   - Update `lastSuccessfulEndTime`.

Recommended Odoo custom field:

- Model: `crm.lead`
- Field name: `x_maqsam_call_id`
- Type: Char

This gives Odoo-side duplicate protection.

## Option B: Host The Node Script Elsewhere

Use this if you want to keep the current script almost exactly as-is.

Host the script on one of:

- Render
- Railway
- Fly.io
- AWS Lambda
- Google Cloud Run
- GitHub Actions scheduled workflow

Then use n8n Cloud either to:

- Call your hosted script endpoint every hour with an `HTTP Request` node, or
- Skip n8n scheduling and let the hosting platform schedule the script.

## Importing Workflow JSON In n8n Cloud

In n8n Cloud:

1. Open your project.
2. Create or open a workflow.
3. Click the three-dot menu in the top-right.
4. Select `Import from File`.
5. Upload the workflow JSON.

The existing `n8n/maqsam-odoo-hourly-workflow.json` file is for self-hosted n8n because it uses `Execute Command`. It is not suitable for n8n Cloud.
