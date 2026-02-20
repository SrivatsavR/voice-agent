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

// â”€â”€â”€ Silence Filler Phrases â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Used when the user hasn't spoken for SILENCE_FILLER_TIMEOUT_MS while the
// agent is also silent. Picks the most contextually neutral phrase.
const SILENCE_FILLER_TIMEOUT_MS = 5000;
const SILENCE_FILLER_PHRASES = [
  "Are you still there?",
  "I'm here whenever you're ready.",
  "Take your time, I'm listening.",
  "Just checking in, is everything okay?",
  "Feel free to continue whenever you're ready.",
  "I didn't catch that, could you speak up a bit?",
  "No rush at all, I'm right here.",
  "Whenever you're ready, go ahead.",
];

/**
 * SilenceFillerManager
 *
 * Starts a countdown whenever neither side is speaking.
 * After SILENCE_FILLER_TIMEOUT_MS of mutual silence it picks a filler phrase
 * and speaks it via TTS. Resets whenever:
 *   - A user transcript arrives
 *   - The agent starts speaking
 *   - The call ends
 */
class SilenceFillerManager {
  constructor(log) {
    this._log = log.withComponent('SilenceFiller');
    this._timer = null;
    this._tts = null;
    this._callSession = null;
  }

  /** Wire up after TTS / callSession are created */
  init(tts, callSession) {
    this._tts = tts;
    this._callSession = callSession;
    this.reset(); // Start the first countdown
  }

  /** Restart the silence countdown */
  reset() {
    this._clearTimer();
    this._timer = setTimeout(() => this._fire(), SILENCE_FILLER_TIMEOUT_MS);
  }

  /** Stop monitoring (call ended) */
  stop() {
    this._clearTimer();
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _fire() {
    if (!this._tts || !this._callSession) return;
    // Do not fire if the agent is still speaking (e.g. long TTS response)
    if (this._tts.isSpeaking) {
      this.reset(); // Check again in another 5s
      return;
    }
    const phrase = SILENCE_FILLER_PHRASES[
      Math.floor(Math.random() * SILENCE_FILLER_PHRASES.length)
    ];
    this._log.info('Firing silence filler phrase', { phrase });
    this._tts.sendText(phrase);
    this._tts.flush();
    // Queue next check after this phrase has a chance to play (~4s)
    this._timer = setTimeout(() => this._fire(), SILENCE_FILLER_TIMEOUT_MS + 4000);
  }
}

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// â”€â”€â”€ Determine ASR provider from env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'elevenlabs').toLowerCase();
serverLog.info('ASR provider configured', { provider: ASR_PROVIDER });

// â”€â”€â”€ Default for interruptions (configurable via env) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DEFAULT_INTERRUPTIONS_ENABLED = process.env.INTERRUPTIONS_ENABLED !== 'false';
serverLog.info('Default interruptions setting', { enabled: DEFAULT_INTERRUPTIONS_ENABLED });

// â”€â”€â”€ Active calls registry (for runtime toggle via API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const activeCalls = new Map(); // callId â†' { interruptionManager, callLog }

// â”€â”€â”€ Twilio Webhook â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Interruption Toggle API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ WebSocket Upgrade Handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ WebSocket (Media Stream) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

wss.on('connection', (ws) => {
  const callId = generateCallId();
  let asr = null;
  let tts = null;
  let callSession = null;
  let isActive = true;
  let activeStreamSid = null;
  let interruptionManager = null;
  let silenceFiller = null;

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

      // Silence filler manager
      silenceFiller = new SilenceFillerManager(callLog);

      // Create TTS with speaking hooks wired to interruption manager + silence filler
      tts = new ElevenLabsTTS(ws, streamSid, {
        logger: callLog,
        onSpeakingStart: () => {
          interruptionManager.onSpeakingStart();
          silenceFiller?.reset(); // While agent speaks, hold the silence timer
        },
        onSpeakingEnd: () => {
          interruptionManager.onSpeakingEnd();
          silenceFiller?.reset(); // Agent finished: restart 5s countdown
        },
      });

      // Transcript handler (shared between ASR providers)
      const onTranscript = async (transcript) => {
        try {
          if (!transcript?.trim() || !isActive) return;

          // Reset silence filler whenever the user says anything
          silenceFiller?.reset();

          // Interruption gate check
          const wasSpeaking = tts?.isSpeaking;
          if (!interruptionManager.shouldProcessTranscript(transcript)) {
            return; // Dropped â€” interruptions disabled and agent is speaking
          }

          // â”€â”€ Barge-in: user spoke while agent was speaking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          // Clear Twilio's audio buffer so the caller hears silence immediately
          if (wasSpeaking && tts) {
            tts.clearAudio();
          }

          callLog.withComponent('User').info(transcript);
          const timer = callLog.withComponent('Workflow').time('processTranscript');
          const result = await callSession.processTranscript(transcript);
          callLog.withComponent('Workflow').timeEnd(timer);
          const { say, next_node, session } = result;

          if (say && tts && isActive) {
            callLog.withComponent('Agent').info(say);
            tts.sendText(say);
            tts.flush(); // Flush immediately â€” no setTimeout delay
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
        // Parallelize: fire LLM welcome call while ASR/TTS handshakes are in progress
        const [_, __, welcome] = await Promise.all([
          tts.waitReady(),
          asr.waitReady(),
          callSession.getWelcome()
        ]);
        log.info('All services ready');
        callLog.withComponent('Agent').info(`Welcome: ${welcome}`);

        if (tts && isActive) {
          tts.sendText(welcome);
          tts.flush(); // Flush immediately â€” no setTimeout delay
        }

        // Start silence filler monitoring AFTER welcome is sent
        silenceFiller.init(tts, callSession);
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
        log.info('Stop is for active stream â€” marking inactive, waiting for WS close');
        isActive = false;
        // Do NOT close ASR/TTS here â€” let the ws.close handler do it.
        // This prevents premature teardown if the stop arrives early.
      } else {
        log.debug('Stop is for a different/unknown stream â€” ignoring');
      }
    }
  });

  ws.on('close', () => {
    const log = callLog.withComponent('WS');
    log.info('Connection closed â€” cleaning up all services');

    if (interruptionManager) {
      log.info('Interruption stats at close', interruptionManager.getStats());
    }

    isActive = false;
    silenceFiller?.stop();
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
    buildTag: 'v21-interruptions-filler-fix',
    asr_provider: ASR_PROVIDER,
    default_interruptions: DEFAULT_INTERRUPTIONS_ENABLED,
    silence_filler_timeout_ms: SILENCE_FILLER_TIMEOUT_MS,
  });
});
