# EC2 Deployment

This project can run well on an EC2 instance. The simplest production setup is:

- Node.js runs `src/sync-maqsam-odoo.js`.
- `systemd` timer runs it every hour.
- `.env` stores Maqsam and Odoo credentials on the EC2 instance.
- `data/state.json` stores sync progress.

## 1. Install Node.js

On Ubuntu/Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

The script requires Node.js 18 or newer.

## 2. Copy The Project To EC2

From your local machine:

```bash
scp -r /Users/macbookpro/Desktop/Code/maqsam-oddo-automation ubuntu@YOUR_EC2_PUBLIC_IP:/home/ubuntu/
```

Or push the project to GitHub and clone it on EC2:

```bash
git clone YOUR_REPO_URL /home/ubuntu/maqsam-oddo-automation
```

## 3. Configure Environment Variables

On EC2:

```bash
cd /home/ubuntu/maqsam-oddo-automation
cp .env.example .env
nano .env
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

Recommended Odoo custom field:

```bash
ODOO_MAQSAM_ID_FIELD=x_maqsam_call_id
```

Protect the secrets file:

```bash
chmod 600 .env
```

## 4. Test Manually

```bash
npm run check
npm run sync:dry-run
```

If the dry run looks good:

```bash
npm run sync
```

## 5. Install systemd Service

Create the service:

```bash
sudo nano /etc/systemd/system/maqsam-odoo-sync.service
```

Paste:

```ini
[Unit]
Description=Maqsam to Odoo CRM sync
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=/home/ubuntu/maqsam-oddo-automation
EnvironmentFile=/home/ubuntu/maqsam-oddo-automation/.env
ExecStart=/usr/bin/node /home/ubuntu/maqsam-oddo-automation/src/sync-maqsam-odoo.js
```

If your EC2 user is not `ubuntu`, change `User=ubuntu` and the paths.

## 6. Install systemd Timer

Create the timer:

```bash
sudo nano /etc/systemd/system/maqsam-odoo-sync.timer
```

Paste:

```ini
[Unit]
Description=Run Maqsam to Odoo CRM sync every hour

[Timer]
OnCalendar=hourly
Persistent=true
Unit=maqsam-odoo-sync.service

[Install]
WantedBy=timers.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now maqsam-odoo-sync.timer
```

## 7. Check Status And Logs

Timer status:

```bash
systemctl list-timers maqsam-odoo-sync.timer
```

Last run status:

```bash
systemctl status maqsam-odoo-sync.service
```

Logs:

```bash
journalctl -u maqsam-odoo-sync.service -n 100 --no-pager
```

Follow logs live during a manual run:

```bash
sudo systemctl start maqsam-odoo-sync.service
journalctl -u maqsam-odoo-sync.service -f
```

## Alternative: Run Through Self-Hosted n8n On EC2

If you still want n8n as the scheduler, run self-hosted n8n on EC2 and import:

```text
n8n/maqsam-odoo-hourly-workflow.json
```

This works on self-hosted n8n because the `Execute Command` node can run the local Node.js script. It does not work on n8n Cloud.

For production, the `systemd` timer is simpler and has fewer moving parts.
