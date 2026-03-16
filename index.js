const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const twilio = require('twilio');
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const AccessToken = require('twilio').jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const config = {
  accountSid:   process.env.TWILIO_ACCOUNT_SID,
  authToken:    process.env.TWILIO_AUTH_TOKEN,
  apiKey:       process.env.TWILIO_API_KEY,
  apiSecret:    process.env.TWILIO_API_SECRET,
  twimlAppSid:  process.env.TWILIO_TWIML_APP_SID,
  twilioNumber: process.env.TWILIO_PHONE_NUMBER || '+14849398817',
  appBaseUrl:   process.env.APP_BASE_URL || 'https://phoenix-phone-server.onrender.com',
  agents: {
    glen:  { name: 'Glen',  identity: 'glen',  available: false, activeSid: null },
    danny: { name: 'Danny', identity: 'danny', available: false, activeSid: null },
  },
};

const CALLRAIL_API_KEY = process.env.CALLRAIL_API_KEY  || '7de6f836a1feee75ce41493f8e9b64af';
const CALLRAIL_ACCOUNT = process.env.CALLRAIL_ACCOUNT  || '906309465';
const SHOPIFY_TOKEN    = process.env.SHOPIFY_TOKEN     || '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';
const SHOPIFY_DOMAIN   = 'electricmotorexperts.myshopify.com';
const FIREBASE_DB      = 'https://checkit-b73a7-default-rtdb.firebaseio.com';

const client = config.accountSid ? twilio(config.accountSid, config.authToken) : null;

const callQueue   = [];
const activeCalls = {};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function pushState() {
  broadcast({ type: 'STATE', queue: callQueue, agents: config.agents, activeCalls, timestamp: Date.now() });
}

wss.on('connection', ws => {
  console.log('[WS] Agent connected');
  ws.send(JSON.stringify({ type: 'STATE', queue: callQueue, agents: config.agents, activeCalls, timestamp: Date.now() }));
  ws.on('message', raw => {
    try { handleAgentMessage(JSON.parse(raw), ws); } catch(e) { console.error('[WS] parse error', e); }
  });
  ws.on('close', () => console.log('[WS] Agent disconnected'));
});

async function handleAgentMessage(msg, ws) {
  const { type, agentId, callSid, targetAgent } = msg;

  if (type === 'SET_AVAILABLE') {
    if (config.agents[agentId]) {
      config.agents[agentId].available = msg.available;
      pushState();
    }
  }

  if (type === 'HOLD') {
    const call = activeCalls[callSid];
    if (!call) return;
    call.onHold = true;
    if (client) {
      await client.calls(callSid).update({
        url: `${config.appBaseUrl}/twiml/hold-loop`,
        method: 'POST',
      }).catch(console.error);
    }
    pushState();
  }

  if (type === 'RESUME') {
    const call = activeCalls[callSid];
    if (!call) return;
    call.onHold = false;
    // Re-conference with agent
    if (client) {
      await client.calls(callSid).update({
        url: `${config.appBaseUrl}/twiml/conference?room=${callSid}`,
        method: 'POST',
      }).catch(console.error);
    }
    pushState();
  }

  if (type === 'TRANSFER') {
    const call = activeCalls[callSid];
    if (!call || !config.agents[targetAgent]) return;
    const fromAgent = call.agentIdentity;
    call.agentIdentity = targetAgent;
    config.agents[fromAgent].activeSid = null;
    config.agents[fromAgent].available = true;
    config.agents[targetAgent].activeSid = callSid;
    config.agents[targetAgent].available = false;
    // Move caller to new conference room with new agent
    if (client) {
      await client.calls(callSid).update({
        url: `${config.appBaseUrl}/twiml/conference?room=${callSid}`,
        method: 'POST',
      }).catch(console.error);
    }
    pushState();
    broadcast({ type: 'INCOMING_TRANSFER', callSid, agentId: targetAgent });
  }

  if (type === 'HANGUP') {
    if (client) {
      await client.calls(callSid).update({ status: 'completed' }).catch(console.error);
    }
    cleanupCall(callSid);
    pushState();
  }
}

function cleanupCall(callSid) {
  const idx = callQueue.findIndex(c => c.callSid === callSid);
  if (idx > -1) callQueue.splice(idx, 1);
  const call = activeCalls[callSid];
  if (call && config.agents[call.agentIdentity]) {
    config.agents[call.agentIdentity].activeSid = null;
    config.agents[call.agentIdentity].available = true;
  }
  delete activeCalls[callSid];
}

// ─── TWILIO VOICE TOKEN ───────────────────────────────────────────────────────
app.post('/token', (req, res) => {
  const { agentId } = req.body;
  if (!config.agents[agentId]) return res.status(400).json({ error: 'Unknown agent' });
  if (!config.apiKey || !config.apiSecret) return res.status(500).json({ error: 'API key not configured' });

  const token = new AccessToken(config.accountSid, config.apiKey, config.apiSecret, { identity: agentId, ttl: 3600 });
  const grant = new VoiceGrant({ outgoingApplicationSid: config.twimlAppSid, incomingAllow: true });
  token.addGrant(grant);
  res.json({ token: token.toJwt(), identity: agentId });
});

// ─── TWILIO WEBHOOKS ─────────────────────────────────────────────────────────

// Inbound call
app.post('/incoming', (req, res) => {
  const { CallSid, From, CallerName } = req.body;
  console.log(`[INCOMING] ${From} SID=${CallSid}`);

  callQueue.push({
    callSid: CallSid,
    caller: From,
    callerName: CallerName || 'Unknown',
    enqueuedAt: Date.now(),
    status: 'waiting',
  });
  pushState();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling Phoenix Phase Converters. Please hold and an agent will be with you shortly.</Say>
  <Play loop="0">https://lucent-bubblegum-bed54c.netlify.app/hold-music.mp3</Play>
</Response>`;
  res.type('text/xml').send(xml);
});

// Hold loop
app.post('/twiml/hold-loop', (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play loop="0">https://lucent-bubblegum-bed54c.netlify.app/hold-music.mp3</Play>
</Response>`;
  res.type('text/xml').send(xml);
});

// Conference room (agent answers via browser)
app.post('/twiml/conference', (req, res) => {
  const { room } = req.query;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference waitUrl="" beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${room}</Conference>
  </Dial>
</Response>`;
  res.type('text/xml').send(xml);
});

// Agent answers - browser SDK calls this via TwiML App
app.post('/twiml/agent-answer', (req, res) => {
  const { callSid, agentId } = req.query;
  console.log(`[AGENT ANSWER] ${agentId} answering ${callSid}`);

  const caller = callQueue.find(c => c.callSid === callSid);
  if (caller) {
    caller.status = 'active';
    activeCalls[callSid] = { agentIdentity: agentId, startedAt: Date.now(), onHold: false };
    if (config.agents[agentId]) {
      config.agents[agentId].activeSid = callSid;
      config.agents[agentId].available = false;
    }
    // Move caller into conference
    if (client) {
      client.calls(callSid).update({
        url: `${config.appBaseUrl}/twiml/conference?room=${callSid}`,
        method: 'POST',
      }).catch(console.error);
    }
    pushState();
  }

  // Agent also joins same conference
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference waitUrl="" beep="false" startConferenceOnEnter="true" endConferenceOnExit="true">${callSid}</Conference>
  </Dial>
</Response>`;
  res.type('text/xml').send(xml);
});

// Call status callback
app.post('/call-status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[STATUS] ${CallSid} => ${CallStatus}`);
  if (['completed', 'canceled', 'failed', 'busy', 'no-answer'].includes(CallStatus)) {
    cleanupCall(CallSid);
    pushState();
  }
  res.sendStatus(200);
});

// Retell transfer
app.post('/retell-transfer', (req, res) => {
  const { call_id, from_number, metadata } = req.body;
  const From = from_number || req.body.From || 'Unknown';
  const CallSid = call_id || req.body.CallSid || `retell-${Date.now()}`;

  if (!callQueue.find(c => c.callSid === CallSid)) {
    callQueue.push({ callSid: CallSid, caller: From, callerName: metadata?.caller_name || 'Unknown', enqueuedAt: Date.now(), status: 'waiting' });
    pushState();
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Please hold while I transfer you.</Say>
  <Play loop="0">https://lucent-bubblegum-bed54c.netlify.app/hold-music.mp3</Play>
</Response>`;
  res.type('text/xml').send(xml);
});

// Manual queue clear
app.post('/clear-queue', (req, res) => {
  callQueue.length = 0;
  Object.keys(activeCalls).forEach(k => delete activeCalls[k]);
  Object.values(config.agents).forEach(a => { a.activeSid = null; });
  pushState();
  res.json({ ok: true });
});

// ─── LOOKUP ROUTES ────────────────────────────────────────────────────────────
app.get('/lookup/callrail', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ calls: [] });
  try {
    const clean = phone.replace(/\D/g, '');
    const r = await fetch(`https://api.callrail.com/v3/a/${CALLRAIL_ACCOUNT}/calls.json?search=${clean}&fields=answered,direction,duration,tracking_source,first_call,created_at,caller_name&per_page=10&sort=created_at&order=desc`, {
      headers: { Authorization: `Token token=${CALLRAIL_API_KEY}` }
    });
    res.json(await r.json());
  } catch(e) { res.json({ calls: [] }); }
});

app.get('/lookup/shopify', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ orders: [], customer: null });
  try {
    const clean = phone.replace(/\D/g, '');
    const r = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/customers/search.json?query=phone:${clean}&fields=id,first_name,last_name,email,phone,orders_count,total_spent`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const d = await r.json();
    if (!d.customers?.length) return res.json({ orders: [], customer: null });
    const cust = d.customers[0];
    const or = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/orders.json?customer_id=${cust.id}&limit=5&status=any`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
    });
    const od = await or.json();
    res.json({ customer: cust, orders: od.orders || [] });
  } catch(e) { res.json({ orders: [], customer: null }); }
});

app.get('/lookup/notes', async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json({ notes: [] });
  try {
    const key = phone.replace(/\D/g, '');
    const r = await fetch(`${FIREBASE_DB}/caller_notes/${key}.json`);
    const d = await r.json();
    res.json({ notes: d || [] });
  } catch(e) { res.json({ notes: [] }); }
});

app.post('/lookup/notes', async (req, res) => {
  const { phone, note, agentId } = req.body;
  if (!phone || !note) return res.status(400).json({ error: 'Missing' });
  try {
    const key = phone.replace(/\D/g, '');
    const r = await fetch(`${FIREBASE_DB}/caller_notes/${key}.json`);
    const existing = await r.json() || [];
    const notes = Array.isArray(existing) ? existing : [];
    notes.unshift({ text: note, ts: Date.now(), agent: agentId || 'unknown' });
    await fetch(`${FIREBASE_DB}/caller_notes/${key}.json`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notes.slice(0, 20))
    });
    res.json({ ok: true, notes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/test-callrail', async (req, res) => {
  try {
    const r = await fetch(`https://api.callrail.com/v3/a/${CALLRAIL_ACCOUNT}/calls.json?per_page=3`, {
      headers: { Authorization: `Token token=${CALLRAIL_API_KEY}` }
    });
    res.json({ status: r.status, body: await r.json() });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, queue: callQueue.length, uptime: process.uptime() }));
app.get('/', (req, res) => res.json({ service: 'Phoenix Phone System', status: 'running' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Phoenix Phone System running on port ${PORT}`);
  console.log(`   Twilio: ${config.twilioNumber}`);
  console.log(`   Base URL: ${config.appBaseUrl}`);
});
