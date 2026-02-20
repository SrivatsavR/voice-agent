import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { ElevenLabsASR } from './services/elevenlabs-asr.js';
import { DeepgramASR } from './services/deepgram-asr.js';
import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import { createCallSession } from './services/agent-workflow.js';
import { Logger, serverLog, wsLog, generateCallId } from './utils/logger.js';
import { InterruptionManager } from './utils/interruption-manager.js';

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Determine ASR provider from env ─────────────────────────────────────────

const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'elevenlabs').toLowerCase();
serverLog.info('ASR provider configured', { provider: ASR_PROVIDER });

// ─── Default for interruptions (configurable via env) ─────────────────────────

const DEFAULT_INTERRUPTIONS_ENABLED = process.env.INTERRUPTIONS_ENABLED !== 'false';
serverLog.info('Default interruptions setting', { enabled: DEFAULT_INTERRUPTIONS_ENABLED });

// ─── Active calls registry (for runtime toggle via API) ──────────────────────

const activeCalls = new Map(); // callId → { interruptionManager, callLog }

// ─── Twilio Webhook ──────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Voice AI Platform Active [v20-logging-interruptions]'));

app.post('/incoming', (req, res) => {
  const caller = req.body.From || 'unknown';
  const host = req.hostname;
  const streamUrl = `wss://${host}/media-stream`;

  serverLog.info('Incoming call', { from: caller, host, streamUrl });

  // CRITICAL: We add a long <Pause> to the TwiML response. 
  // This ensures Twilio doesn't hang up the call as soon as the <Connect> verb finishes executing.
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${streamUrl}">
            <Parameter name="caller_phone" value="${caller}" />
        </Stream>
    </Connect>
    <Pause length="3600" />
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(twimlResponse);
});

// ─── Interruption Toggle API ─────────────────────────────────────────────────

/**
 * POST /interruptions
 * Body: { "enabled": true|false }
 * 
 * Sets interruption state for ALL active calls.
 * Returns the current state of all calls.
 */
app.post('/interruptions', (req, res) => {
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      error: 'Missing or invalid "enabled" field. Must be boolean.',
      example: { enabled: true }
    });
  }

  serverLog.info('Interruption toggle (global)', { enabled, active_calls: activeCalls.size });

  const results = [];
  for (const [callId, call] of activeCalls) {
    call.interruptionManager.setInterruptionsEnabled(enabled);
    results.push({
      callId,
      interruptionsEnabled: call.interruptionManager.isInterruptionsEnabled(),
    });
  }

  res.json({
    success: true,
    interruptions_enabled: enabled,
    affected_calls: results,
  });
});

/**
 * POST /interruptions/:callId
 * Body: { "enabled": true|false }
 * 
 * Sets interruption state for a SPECIFIC call.
 */
app.post('/interruptions/:callId', (req, res) => {
  const { callId } = req.params;
  const { enabled } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({
      error: 'Missing or invalid "enabled" field. Must be boolean.',
      example: { enabled: true }
    });
  }

  const call = activeCalls.get(callId);
  if (!call) {
    return res.status(404).json({ error: `Call ${callId} not found or already ended.` });
  }

  call.interruptionManager.setInterruptionsEnabled(enabled);
  serverLog.info('Interruption toggle (per-call)', { callId, enabled });

  res.json({
    success: true,
    callId,
    interruptionsEnabled: call.interruptionManager.isInterruptionsEnabled(),
    stats: call.interruptionManager.getStats(),
  });
});

/**
 * GET /interruptions
 * 
 * Returns the current interruption state for all active calls.
 */
app.get('/interruptions', (req, res) => {
  const calls = [];
  for (const [callId, call] of activeCalls) {
    calls.push({
      callId,
      ...call.interruptionManager.getStats(),
    });
  }
  res.json({ active_calls: calls.length, calls });
});

/**
 * GET /calls
 * 
 * Returns a list of all active calls.
 */
app.get('/calls', (req, res) => {
  const calls = [];
  for (const [callId, call] of activeCalls) {
    calls.push({
      callId,
      ...call.interruptionManager.getStats(),
    });
  }
  res.json({ active_calls: calls.length, calls });
});

// ─── WebSocket Upgrade Handling ──────────────────────────────────────────────

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url, `http://${request.headers.host}`);
  if (pathname === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ─── WebSocket (Media Stream) ─────────────────────────────────────────────────

wss.on('connection', (ws) => {
  const callId = generateCallId();
  let asr = null;
  let tts = null;
  let callSession = null;
  let isActive = true;
  let ignoreAsrUntil = 0;
  let activeStreamSid = null;
  let interruptionManager = null;

  // Create call-scoped logger (will get streamSid and callerPhone later)
  let callLog = Logger.forCall(callId, null, null);

  callLog.withComponent('WS').info('WebSocket connection accepted');

  ws.on('message', async (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    if (msg.event === 'start') {
      const streamSid = msg.start.streamSid;
      const callerPhone = msg.start.customParameters?.caller_phone ?? '';
      activeStreamSid = streamSid;

      // Update logger with full call context
      callLog = Logger.forCall(callId, streamSid, callerPhone);
      const log = callLog.withComponent('WS');

      log.info('Stream starting', { streamSid, callerPhone, asr_provider: ASR_PROVIDER });

      // Create interruption manager for this call
      interruptionManager = new InterruptionManager(callLog, DEFAULT_INTERRUPTIONS_ENABLED);

      // Register call in active calls
      activeCalls.set(callId, { interruptionManager, callLog });

      // Create TTS with speaking hooks wired to interruption manager
      tts = new ElevenLabsTTS(ws, streamSid, {
        logger: callLog,
        onSpeakingStart: () => interruptionManager.onSpeakingStart(),
        onSpeakingEnd: () => interruptionManager.onSpeakingEnd(),
      });

      // Transcript handler (shared between ASR providers)
      const onTranscript = async (transcript) => {
        try {
          if (!transcript?.trim() || !isActive) return;
          if (Date.now() < ignoreAsrUntil) {
            callLog.withComponent('ASR').debug('Echo suppression active, ignoring transcript', {
              transcript: transcript.substring(0, 60),
              remaining_ms: ignoreAsrUntil - Date.now(),
            });
            return;
          }

          // Interruption gate check
          if (!interruptionManager.shouldProcessTranscript(transcript)) {
            return; // Dropped — interruptions disabled and agent is speaking
          }

          callLog.withComponent('User').info(transcript);
          const timer = callLog.withComponent('Workflow').time('processTranscript');
          const result = await callSession.processTranscript(transcript);
          callLog.withComponent('Workflow').timeEnd(timer);
          const { say, next_node, session } = result;

          if (say && tts && isActive) {
            callLog.withComponent('Agent').info(say);
            tts.sendText(say);
            setTimeout(() => { if (isActive) tts.flush(); }, 100);
          }

          if (callSession.isTerminal()) {
            isActive = false;
            callLog.withComponent('Call').info('Call reached terminal node', {
              outcome: session.call_outcome,
              node: next_node,
            });
            setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 5000);
          }
        } catch (err) {
          callLog.withComponent('WS').error('ASR callback error', err);
        }
      };

      // Create ASR based on configured provider
      const asrOptions = { logger: callLog };
      if (ASR_PROVIDER === 'deepgram') {
        asr = new DeepgramASR(onTranscript, asrOptions);
      } else {
        asr = new ElevenLabsASR(onTranscript, asrOptions);
      }

      callSession = createCallSession(callerPhone, { logger: callLog });

      try {
        // Wait for service handshakes
        const connectTimer = log.time('serviceConnect');
        await Promise.all([tts.waitReady(), asr.waitReady()]);
        log.timeEnd(connectTimer);
        log.info('All services ready');

        const welcomeTimer = callLog.withComponent('Workflow').time('getWelcome');
        const welcome = await callSession.getWelcome();
        callLog.withComponent('Workflow').timeEnd(welcomeTimer);
        callLog.withComponent('Agent').info(`Welcome: ${welcome}`);

        if (tts && isActive) {
          ignoreAsrUntil = Date.now() + 6000;
          tts.sendText(welcome);
          setTimeout(() => { if (isActive) tts.flush(); }, 100);
        }
      } catch (err) {
        callLog.withComponent('WS').error('Welcome generation error', err);
      }
    }
    else if (msg.event === 'media') {
      if (isActive) asr?.sendAudio(msg.media.payload);
    }
    else if (msg.event === 'stop') {
      // IMPORTANT: Do NOT tear down ASR/TTS here.
      // Twilio can send 'stop' prematurely or for a previous stream.
      // The actual cleanup should only happen on ws.close.
      // If the caller truly hung up, Twilio will also close the WebSocket.
      const stopStreamSid = msg.stop?.streamSid || 'unknown';
      const log = callLog.withComponent('WS');

      log.info('Stop command from Twilio', { stopStreamSid, activeStreamSid });

      // Only mark inactive if this stop is for our active stream
      if (stopStreamSid === activeStreamSid) {
        log.info('Stop is for active stream — marking inactive, waiting for WS close');
        isActive = false;
        // Do NOT close ASR/TTS here — let the ws.close handler do it.
        // This prevents premature teardown if the stop arrives early.
      } else {
        log.debug('Stop is for a different/unknown stream — ignoring');
      }
    }
  });

  ws.on('close', () => {
    const log = callLog.withComponent('WS');
    log.info('Connection closed — cleaning up all services');

    if (interruptionManager) {
      log.info('Interruption stats at close', interruptionManager.getStats());
    }

    isActive = false;
    asr?.close();
    tts?.close();

    // Unregister from active calls
    activeCalls.delete(callId);
    log.info('Call cleanup complete', { callId });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  serverLog.info(`Server listening`, {
    port: PORT,
    buildTag: 'v20-logging-interruptions',
    asr_provider: ASR_PROVIDER,
    default_interruptions: DEFAULT_INTERRUPTIONS_ENABLED,
  });
});
