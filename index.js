const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const twilio = require('twilio');
const VoiceResponse = require('twilio').twiml.VoiceResponse;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const config = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  twilioNumber: process.env.TWILIO_PHONE_NUMBER || '+18004176568',
  appBaseUrl: process.env.APP_BASE_URL,
  agents: {
    glen: { name: 'Glen', phone: '+16029628859', identity: 'glen', available: false, activeSid: null },
    danny: { name: 'Danny', phone: '+16023309595', identity: 'danny', available: false, activeSid: null },
  },
};

const client = twilio(config.accountSid, config.authToken);
const callQueue = [];
const activeCalls = {};

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}

function pushState() {
  broadcast({ type: 'STATE', queue: callQueue, agents: config.agents, activeCalls, timestamp: Date.now() });
}

wss.on('connection', (ws) => {
  console.log('Dashboard connected');
  ws.send(JSON.stringify({ type: 'STATE', queue: callQueue, agents: config.agents, activeCalls, timestamp: Date.now() }));
  ws.on('message', (raw) => {
    try { handleAgentMessage(JSON.parse(raw), ws); } catch (e) { console.error('WS parse error', e); }
  });
});

async function handleAgentMessage(msg, ws) {
  const { type, agentId, callSid, targetAgent } = msg;
  if (type === 'SET_AVAILABLE') {
    if (config.agents[agentId]) { config.agents[agentId].available = msg.available; pushState(); }
  }
  if (type === 'ANSWER_NEXT') {
    const next = callQueue.find((c) => c.status === 'waiting');
    if (!next) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'No callers in queue' }));
    if (!config.agents[agentId]?.available) return ws.send(JSON.stringify({ type: 'ERROR', msg: 'Set yourself available first' }));
    try {
      await client.calls(next.callSid).update({ url: config.appBaseUrl + '/twiml/bridge-to-agent?agentId=' + agentId + '&callSid=' + next.callSid, method: 'POST' });
      next.status = 'connecting'; pushState();
    } catch (e) { console.error('Dequeue error', e); }
  }
  if (type === 'HOLD' && activeCalls[callSid]) {
    try {
      await client.calls(callSid).update({ url: config.appBaseUrl + '/twiml/hold', method: 'POST' });
      activeCalls[callSid].onHold = true; pushState();
    } catch (e) { console.error('Hold error', e); }
  }
  if (type === 'UNHOLD' && activeCalls[callSid]) {
    const agent = activeCalls[callSid].agentIdentity;
    try {
      await client.calls(callSid).update({ url: config.appBaseUrl + '/twiml/bridge-to-agent?agentId=' + agent + '&callSid=' + callSid + '&resume=true', method: 'POST' });
      activeCalls[callSid].onHold = false; pushState();
    } catch (e) { console.error('Unhold error', e); }
  }
  if (type === 'TRANSFER' && activeCalls[callSid] && targetAgent && config.agents[targetAgent]) {
    try {
      await client.calls(callSid).update({ url: config.appBaseUrl + '/twiml/transfer?targetAgent=' + targetAgent, method: 'POST' });
      const prev = activeCalls[callSid].agentIdentity;
      activeCalls[callSid].agentIdentity = targetAgent;
      if (config.agents[prev]) config.agents[prev].activeSid = null;
      config.agents[targetAgent].activeSid = callSid; pushState();
    } catch (e) { console.error('Transfer error', e); }
  }
  if (type === 'HANGUP') {
    try {
      await client.calls(callSid).update({ status: 'completed' });
      delete activeCalls[callSid];
      const idx = callQueue.findIndex((c) => c.callSid === callSid);
      if (idx > -1) callQueue.splice(idx, 1);
      Object.values(config.agents).forEach((a) => { if (a.activeSid === callSid) a.activeSid = null; });
      pushState();
    } catch (e) { console.error('Hangup error', e); }
  }
}

app.post('/incoming', (req, res) => {
  const { CallSid, From, CallerName } = req.body;
  console.log('Incoming call: ' + CallSid + ' from ' + From);
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while I transfer you.');
  twiml.enqueue({ waitUrl: config.appBaseUrl + '/twiml/wait', action: config.appBaseUrl + '/twiml/queue-complete' }, 'support');
  callQueue.push({ callSid: CallSid, caller: From, callerName: CallerName || From, enqueuedAt: Date.now(), status: 'waiting' });
  pushState();
  res.type('text/xml').send(twiml.toString());
});

app.post('/retell-transfer', (req, res) => {
  const { CallSid, From, CallerName } = req.body;
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Please hold while I transfer you.');
  twiml.enqueue({ waitUrl: config.appBaseUrl + '/twiml/wait', action: config.appBaseUrl + '/twiml/queue-complete' }, 'support');
  if (CallSid) { callQueue.push({ callSid: CallSid, caller: From, callerName: CallerName || From, enqueuedAt: Date.now(), status: 'waiting' }); pushState(); }
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/wait', (req, res) => {
  const twiml = new VoiceResponse();
  const queueLen = callQueue.filter((c) => c.status === 'waiting').length;
  twiml.say({ voice: 'Polly.Joanna' }, queueLen > 1 ? 'All team members are with other customers. You are number ' + queueLen + ' in line. Please hold.' : 'Thank you for your patience. Please continue to hold.');
  twiml.play({ loop: 30 }, 'https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3');
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/hold', (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna' }, 'Please hold for a moment.');
  twiml.play({ loop: 20 }, 'https://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3');
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/bridge-to-agent', (req, res) => {
  const { agentId, callSid, resume } = req.query;
  const agent = config.agents[agentId];
  if (!agent) return res.status(400).send('Unknown agent');
  const roomName = 'room-' + callSid;
  const twiml = new VoiceResponse();
  if (!resume) twiml.say({ voice: 'Polly.Joanna' }, 'Connecting you now.');
  const dial = twiml.dial();
  dial.conference(roomName, { startConferenceOnEnter: true, endConferenceOnExit: false, waitUrl: config.appBaseUrl + '/twiml/hold' });
  client.calls.create({ to: agent.phone, from: config.twilioNumber, url: config.appBaseUrl + '/twiml/agent-conference?room=' + roomName + '&agentId=' + agentId + '&callSid=' + callSid })
    .then(() => {
      agent.activeSid = callSid; config.agents[agentId].available = false;
      const entry = callQueue.find((c) => c.callSid === callSid);
      if (entry) entry.status = 'active';
      activeCalls[callSid] = { agentIdentity: agentId, startedAt: Date.now(), onHold: false, room: roomName };
      pushState();
    }).catch(console.error);
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/agent-conference', (req, res) => {
  const { room, agentId, callSid } = req.query;
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference(room, { startConferenceOnEnter: true, endConferenceOnExit: true, statusCallback: config.appBaseUrl + '/conference-status?agentId=' + agentId + '&callSid=' + callSid, statusCallbackEvent: 'end' });
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/transfer', (req, res) => {
  const { targetAgent } = req.query;
  const agent = config.agents[targetAgent];
  const twiml = new VoiceResponse();
  if (!agent) { twiml.say({ voice: 'Polly.Joanna' }, 'Transfer failed. Keeping you connected.'); }
  else { twiml.say({ voice: 'Polly.Joanna' }, 'Transferring you now.'); twiml.dial().number(agent.phone); }
  res.type('text/xml').send(twiml.toString());
});

app.post('/twiml/queue-complete', (req, res) => {
  const { CallSid } = req.body;
  const idx = callQueue.findIndex((c) => c.callSid === CallSid);
  if (idx > -1) callQueue.splice(idx, 1);
  delete activeCalls[CallSid];
  Object.values(config.agents).forEach((a) => { if (a.activeSid === CallSid) { a.activeSid = null; a.available = true; } });
  pushState();
  res.type('text/xml').send(new VoiceResponse().toString());
});

app.post('/conference-status', (req, res) => {
  const { agentId, callSid } = req.query;
  if (config.agents[agentId]) { config.agents[agentId].activeSid = null; config.agents[agentId].available = true; }
  delete activeCalls[callSid];
  const idx = callQueue.findIndex((c) => c.callSid === callSid);
  if (idx > -1) callQueue.splice(idx, 1);
  pushState(); res.sendStatus(200);
});

app.post('/token', (req, res) => {
  const { agentId } = req.body;
  if (!config.agents[agentId]) return res.status(400).json({ error: 'Unknown agent' });
  const AccessToken = require('twilio').jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;
  const token = new AccessToken(config.accountSid, process.env.TWILIO_API_KEY, process.env.TWILIO_API_SECRET, { identity: agentId });
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID, incomingAllow: true }));
  res.json({ token: token.toJwt(), identity: agentId });
});

app.get('/health', (req, res) => res.json({ ok: true, queue: callQueue.length, agents: Object.keys(config.agents) }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Phoenix Phone System running on port ' + PORT));
