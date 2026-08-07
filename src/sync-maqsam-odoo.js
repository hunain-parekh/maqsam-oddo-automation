import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_ENV = [
  'MAQSAM_BASE_URL',
  'MAQSAM_ACCESS_KEY_ID',
  'MAQSAM_ACCESS_SECRET',
  'ODOO_URL',
  'ODOO_DB',
  'ODOO_USERNAME',
  'ODOO_API_KEY',
];

loadDotEnv();

const config = {
  maqsamBaseUrl: requireEnv('MAQSAM_BASE_URL'),
  maqsamAccessKeyId: requireEnv('MAQSAM_ACCESS_KEY_ID'),
  maqsamAccessSecret: requireEnv('MAQSAM_ACCESS_SECRET'),
  odooUrl: trimTrailingSlash(requireEnv('ODOO_URL')),
  odooDb: requireEnv('ODOO_DB'),
  odooUsername: requireEnv('ODOO_USERNAME'),
  odooApiKey: requireEnv('ODOO_API_KEY'),
  odooModel: env('ODOO_MODEL', 'crm.lead'),
  odooLeadType: env('ODOO_LEAD_TYPE', 'lead'),
  odooMaqsamIdField: env('ODOO_MAQSAM_ID_FIELD', 'x_maqsam_call_id').trim(),
  odooTeamId: optionalInteger('ODOO_TEAM_ID'),
  odooUserId: optionalInteger('ODOO_USER_ID'),
  stateFile: env('SYNC_STATE_FILE', 'data/state.json'),
  firstRunMode: env('SYNC_FIRST_RUN_MODE', 'latest_page'),
  initialImportPages: integerEnv('SYNC_INITIAL_IMPORT_PAGES', 1),
  initialLookbackSeconds: integerEnv('SYNC_INITIAL_LOOKBACK_SECONDS', 7200),
  overlapSeconds: integerEnv('SYNC_OVERLAP_SECONDS', 300),
  endDelaySeconds: integerEnv('SYNC_END_DELAY_SECONDS', 60),
  maxPages: integerEnv('SYNC_MAX_PAGES', 100),
  processedIdRetentionSeconds: integerEnv('SYNC_PROCESSED_ID_RETENTION_SECONDS', 604800),
  dryRun: booleanEnv('SYNC_DRY_RUN', false),
};

for (const key of REQUIRED_ENV) {
  requireEnv(key);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

async function main() {
  const state = await loadState(config.stateFile);
  const endTime = Math.floor(Date.now() / 1000) - config.endDelaySeconds;
  const isInitialRun = !state.lastSuccessfulEndTime;
  let startTime = null;
  let calls;

  if (isInitialRun && config.firstRunMode === 'latest_page') {
    console.log(`Initial sync: fetching latest ${config.initialImportPages} Maqsam page(s) without date filters.`);
    calls = await fetchMaqsamCalls({ maxPages: config.initialImportPages });
  } else {
    startTime = state.lastSuccessfulEndTime
      ? Math.max(0, state.lastSuccessfulEndTime - config.overlapSeconds)
      : Math.max(0, endTime - config.initialLookbackSeconds);

    console.log(`Sync window: ${startTime} -> ${endTime}`);

    if (endTime <= startTime) {
      console.log('Nothing to do: sync window is empty.');
      return;
    }

    calls = await fetchMaqsamCalls({ startTime, endTime, maxPages: config.maxPages });
  }

  pruneProcessedIds(state, (startTime ?? endTime) - config.processedIdRetentionSeconds);

  const newCalls = selectNewCalls(calls, state);

  console.log(`Maqsam returned ${calls.length} calls; ${newCalls.length} are new for this workflow.`);

  if (config.dryRun) {
    if (newCalls.length === 0) {
      console.log('Dry run enabled. No new calls found and state was not modified.');
      return;
    }

    console.log('Dry run enabled. Calls that would be pushed:');
    for (const call of newCalls) {
      console.log(JSON.stringify(summarizeCall(call)));
    }
    console.log('Dry run complete. State was not modified.');
    return;
  }

  if (newCalls.length === 0) {
    state.lastSuccessfulEndTime = endTime;
    await saveState(config.stateFile, state);
    console.log('State advanced; no CRM records needed.');
    return;
  }

  const uid = await authenticateOdoo();
  const successes = [];
  const failures = [];

  for (const call of newCalls) {
    try {
      const existingId = config.odooMaqsamIdField
        ? await findExistingOdooLead(uid, call.id)
        : null;

      if (existingId) {
        console.log(`Skipping Maqsam call ${call.id}; already exists in Odoo lead ${existingId}.`);
        successes.push(call);
        continue;
      }

      const leadId = await createOdooLead(uid, call);
      console.log(`Created Odoo lead ${leadId} for Maqsam call ${call.id}.`);
      successes.push(call);
    } catch (error) {
      failures.push({ call, error });
      console.error(`Failed Maqsam call ${call.id}: ${error.message}`);
    }
  }

  for (const call of successes) {
    state.processedCallIds[String(call.id)] = Number(call.timestamp || endTime);
  }

  if (failures.length === 0) {
    state.lastSuccessfulEndTime = endTime;
  }

  await saveState(config.stateFile, state);

  if (failures.length > 0) {
    throw new Error(
      `Odoo push failed for ${failures.length} call(s). State saved for successful calls, but lastSuccessfulEndTime was not advanced.`,
    );
  }

  console.log(`Done. Pushed ${successes.length} call(s) and advanced state to ${endTime}.`);
}

async function fetchMaqsamCalls({ startTime = null, endTime = null, maxPages = config.maxPages } = {}) {
  const allCalls = [];
  const endpoint = maqsamCallsEndpoint(config.maqsamBaseUrl);
  const auth = Buffer.from(`${config.maqsamAccessKeyId}:${config.maqsamAccessSecret}`).toString('base64');

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(endpoint);
    url.searchParams.set('page', String(page));

    if (startTime !== null) {
      url.searchParams.set('start_time', String(startTime));
    }

    if (endTime !== null) {
      url.searchParams.set('end_time', String(endTime));
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });

    const body = await readJsonResponse(response, `Maqsam calls page ${page}`);
    const calls = Array.isArray(body.message) ? body.message : [];
    allCalls.push(...calls);

    console.log(`Fetched Maqsam page ${page}: ${calls.length} call(s).`);

    if (calls.length < 100) {
      break;
    }
  }

  return allCalls;
}

function selectNewCalls(calls, state) {
  const seenThisRun = new Set();

  return calls
    .filter((call) => call && call.id !== undefined && call.id !== null)
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0))
    .filter((call) => {
      const id = String(call.id);
      if (seenThisRun.has(id) || state.processedCallIds[id]) {
        return false;
      }
      seenThisRun.add(id);
      return true;
    });
}

async function authenticateOdoo() {
  const uid = await odooJsonRpc('common', 'authenticate', [
    config.odooDb,
    config.odooUsername,
    config.odooApiKey,
    {},
  ]);

  if (!uid) {
    throw new Error('Odoo authentication failed. Check ODOO_DB, ODOO_USERNAME, and ODOO_API_KEY.');
  }

  return uid;
}

async function findExistingOdooLead(uid, maqsamCallId) {
  const records = await odooExecuteKw(uid, config.odooModel, 'search_read', [
    [[config.odooMaqsamIdField, '=', String(maqsamCallId)]],
  ], {
    fields: ['id'],
    limit: 1,
  });

  return records?.[0]?.id || null;
}

async function createOdooLead(uid, call) {
  const fields = buildLeadFields(call);
  return odooExecuteKw(uid, config.odooModel, 'create', [fields]);
}

function buildLeadFields(call) {
  const phone = bestPhone(call);
  const direction = call.direction || call.type || 'call';
  const timestamp = Number(call.timestamp || 0);
  const happenedAt = timestamp ? new Date(timestamp * 1000).toISOString() : 'Unknown';
  const agentEmails = Array.isArray(call.agents)
    ? call.agents.map((agent) => agent.email).filter(Boolean).join(', ')
    : '';

  const fields = {
    name: `Maqsam ${direction} call${phone ? ` - ${phone}` : ''}`,
    type: config.odooLeadType,
    phone: phone || undefined,
    description: [
      `Maqsam Call ID: ${call.id}`,
      `Direction: ${call.direction || ''}`,
      `Type: ${call.type || ''}`,
      `State: ${call.state || ''}`,
      `Timestamp: ${happenedAt}`,
      `Duration: ${call.duration ?? ''} seconds`,
      `Caller: ${call.caller || ''}`,
      `Caller Number: ${call.callerNumber || ''}`,
      `Callee: ${call.callee || ''}`,
      `Callee Number: ${call.calleeNumber || ''}`,
      `Agents: ${agentEmails}`,
      `Tags: ${arrayToText(call.callTags)}`,
      `Auto Tags: ${arrayToText(call.callAutoTags)}`,
      `Sentiment: ${call.sentiment || ''}`,
      '',
      call.summary ? `Summary:\n${call.summary}` : '',
    ].filter(Boolean).join('\n'),
  };

  if (config.odooMaqsamIdField) {
    fields[config.odooMaqsamIdField] = String(call.id);
  }

  if (config.odooTeamId) {
    fields.team_id = config.odooTeamId;
  }

  if (config.odooUserId) {
    fields.user_id = config.odooUserId;
  }

  return removeUndefined(fields);
}

async function odooExecuteKw(uid, model, method, args = [], kwargs = {}) {
  return odooJsonRpc('object', 'execute_kw', [
    config.odooDb,
    uid,
    config.odooApiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}

async function odooJsonRpc(service, method, args) {
  const response = await fetch(`${config.odooUrl}/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'call',
      params: {
        service,
        method,
        args,
      },
      id: Date.now(),
    }),
  });

  const body = await readJsonResponse(response, `Odoo ${service}.${method}`);

  if (body.error) {
    throw new Error(body.error.data?.message || body.error.message || JSON.stringify(body.error));
  }

  return body.result;
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label} returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${JSON.stringify(body)}`);
  }

  return body;
}

async function loadState(filePath) {
  try {
    const state = JSON.parse(await readFile(filePath, 'utf8'));
    return {
      lastSuccessfulEndTime: Number(state.lastSuccessfulEndTime || 0),
      processedCallIds: state.processedCallIds || {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return {
      lastSuccessfulEndTime: 0,
      processedCallIds: {},
    };
  }
}

async function saveState(filePath, state) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });

  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tempPath, filePath);
}

function pruneProcessedIds(state, minimumTimestamp) {
  for (const [id, timestamp] of Object.entries(state.processedCallIds)) {
    if (Number(timestamp) < minimumTimestamp) {
      delete state.processedCallIds[id];
    }
  }
}

function maqsamCallsEndpoint(baseUrl) {
  const host = baseUrl
    .replace(/^https?:\/\//, '')
    .replace(/^api\./, '')
    .split('/')[0];

  return `https://api.${host}/v2/calls`;
}

function bestPhone(call) {
  if (call.direction === 'inbound') {
    return call.callerNumber || call.calleeNumber || '';
  }

  return call.calleeNumber || call.callerNumber || '';
}

function summarizeCall(call) {
  return {
    id: call.id,
    timestamp: call.timestamp,
    direction: call.direction,
    state: call.state,
    phone: bestPhone(call),
  };
}

function arrayToText(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function removeUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function loadDotEnv() {
  let content;

  try {
    content = readFileSync('.env', 'utf8');
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      continue;
    }

    const [key, ...valueParts] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=').replace(/^["']|["']$/g, '');
    }
  }
}

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function integerEnv(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer.`);
  }

  return value;
}

function optionalInteger(name) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return null;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer when set.`);
  }

  return value;
}

function booleanEnv(name, fallback) {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'y'].includes(rawValue.toLowerCase());
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}
