import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import twilio from 'twilio';
import { ElevenLabsASR } from './services/elevenlabs-asr.js';
import { DeepgramASR } from './services/deepgram-asr.js';
import { transcribeAudioBurst } from './utils/deepgram-rest.js';
import { normalizeSpokenEmailTool, validateEmailTool } from './utils/validators.js';
import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import { createCallSession } from './services/agent-workflow.js';
import { generateContextualFiller } from './services/silence-filler-llm.js';
import { Logger, serverLog, wsLog, generateCallId, getMemoryLogs, onLog } from './utils/logger.js';
import { InterruptionManager } from './utils/interruption-manager.js';
import { getHistory, saveToHistory } from './services/history-service.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
// Import validators for background streaming extraction and burst correction handled above

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// detect silence after 3s
const SILENCE_FILLER_TIMEOUT_MS = 7000;

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
    this._fireTimer = null;
    this._tts = null;
    this._callSession = null;
    this._active = false;
    this._paused = false;
  }

  /** Wire up after TTS / callSession are created */
  init(tts, callSession) {
    this._tts = tts;
    this._callSession = callSession;
    this._active = true;
    this._paused = false;
    this.reset();
  }

  /** Restart the silence countdown */
  reset() {
    if (!this._active) return;
    this._clearTimers();

    if (this._paused) return;

    // Fire static phrase at configured mutual silence timeout
    this._fireTimer = setTimeout(() => this._fire(), SILENCE_FILLER_TIMEOUT_MS);
  }

  /** Stop monitoring (call ended) */
  stop() {
    this._active = false;
    this._paused = false;
    this._clearTimers();
    this._log.info('Stopped silence filler monitoring');
  }

  /** Temporarily stop the countdown (e.g. while agent is thinking) */
  pause() {
    this._paused = true;
    this._clearTimers();
    this._log.debug('Silence filler paused');
  }

  /** Restart the countdown */
  resume() {
    if (this._active) {
      this._paused = false;
      this.reset();
      this._log.debug('Silence filler resumed');
    }
  }

  _clearTimers() {
    if (this._fireTimer) {
      clearTimeout(this._fireTimer);
      this._fireTimer = null;
    }
  }

  _fire() {
    if (!this._active || this._paused || !this._tts) return;

    if (this._tts.isSpeaking || (this._tts.hasPendingAudio && this._tts.hasPendingAudio())) {
      this._log.debug('Aborting filler: Agent is speaking or about to speak');
      this.reset();
      return;
    }

    // Safety check: is TTS still connected and ready?
    if (this._tts.isReady && this._tts.ws?.readyState === WebSocket.OPEN) {
      const name = this._callSession?.getSession()?.name_spoken || '';
      const phrase = name ? `${name} ji, kya aapko meri awaaz aa rahi hai?` : `Hello, kya aap mujhe sun pa rahe hain?`;

      this._log.info(`Firing silence filler phrase at ${SILENCE_FILLER_TIMEOUT_MS / 1000}s`, { phrase });
      this._tts.sendText(phrase);
      this._tts.flush();
    } else {
      this._log.debug('Aborting filler: TTS not ready or closed', {
        ready: this._tts.isReady,
        wsState: this._tts.ws?.readyState
      });
    }

    // Reset for next potential silence gap
    this.reset();
  }
}

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// â”€â”€â”€ Determine ASR provider from env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'deepgram').toLowerCase();
serverLog.info('ASR provider configured', { provider: ASR_PROVIDER });

// â”€â”€â”€ Default for interruptions (configurable via env) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DEFAULT_INTERRUPTIONS_ENABLED = process.env.INTERRUPTIONS_ENABLED !== 'false';
serverLog.info('Default interruptions setting', { enabled: DEFAULT_INTERRUPTIONS_ENABLED });

// â”€â”€â”€ Active calls registry (for runtime toggle via API) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const activeCalls = new Map(); // callId → { interruptionManager, callLog }

// ─── Twilio Initialization ───────────────────────────────────────────────────

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

if (!twilioClient) {
  serverLog.warn('Twilio credentials missing. Outbound calls will be disabled.');
}


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

// ─── Frontend Support APIs ───────────────────────────────────────────────────

const liveSessions = new Map();

/**
 * GET /api/history
 * Returns last calls history
 */
app.get('/api/history', (req, res) => {
  const activeList = [];
  for (const [callId, call] of activeCalls) {
    if (call.callSession) {
      const sess = call.callSession.getSession();
      activeList.push({
        callId,
        ...sess,
        timestamp: new Date().toISOString(),
        call_outcome: sess.call_outcome || 'in_progress'
      });
    }
  }
  for (const [callId, sessionObj] of liveSessions) {
    const sess = sessionObj.getSession();
    activeList.push({
      callId,
      ...sess,
      timestamp: new Date().toISOString(),
      call_outcome: sess.call_outcome || 'in_progress'
    });
  }
  const fullHistory = [...activeList, ...getHistory()];
  res.json(fullHistory);
});

/**
 * GET /api/logs/:callId
 * Returns memory logs for a specific call
 */
app.get('/api/logs/:callId', (req, res) => {
  const { callId } = req.params;
  try {
    const logs = getMemoryLogs(callId);
    res.json(logs);
  } catch (err) {
    serverLog.error('Error fetching memory logs', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

/**
 * GET /api/events/:callId
 * SSE endpoint for real-time log updates
 */
app.get('/api/events/:callId', (req, res) => {
  const { callId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const cleanup = onLog((entry) => {
    if (entry.callId === callId) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
  });

  req.on('close', () => {
    cleanup();
    res.end();
  });
});

/**
 * POST /api/chat
 * Simulated chat endpoint using the same agent workflow
 */
app.post('/api/chat', async (req, res) => {
  const { text, callId: existingCallId, callerPhone = 'chat-user' } = req.body;

  let callId = existingCallId;
  let sessionObj = null;

  if (!callId) {
    callId = generateCallId();
    sessionObj = createCallSession(callerPhone, { logger: Logger.forCall(callId, 'chat', callerPhone) });
    liveSessions.set(callId, sessionObj);
    // Mock welcome
    const welcome = await sessionObj.getWelcome();
    return res.json({
      callId,
      say: welcome,
      session: sessionObj.getSession()
    });
  }

  sessionObj = liveSessions.get(callId);
  if (!sessionObj) {
    // Session expired or not found — recreate and process the pending message
    // so the user's input isn't silently lost on server restart.
    callId = generateCallId();
    sessionObj = createCallSession(callerPhone, { logger: Logger.forCall(callId, 'chat', callerPhone) });
    liveSessions.set(callId, sessionObj);
    const welcome = await sessionObj.getWelcome();

    if (text?.trim()) {
      // Process the user's message in the new session so it's not lost
      try {
        const result = await sessionObj.processTranscript(text);
        if (sessionObj.isTerminal()) {
          saveToHistory(sessionObj.getSession());
          liveSessions.delete(callId);
        }
        return res.json({
          callId,
          welcome,
          ...result,
          wasExpired: true
        });
      } catch (err) {
        serverLog.error('Chat resume error', err);
      }
    }

    return res.json({
      callId,
      say: welcome,
      session: sessionObj.getSession(),
      wasExpired: true
    });
  }

  try {
    const result = await sessionObj.processTranscript(text);

    if (sessionObj.isTerminal()) {
      saveToHistory(sessionObj.getSession());
      liveSessions.delete(callId);
    }

    res.json({
      callId,
      ...result
    });
  } catch (err) {
    serverLog.error('Chat error', err);
    res.status(500).json({ error: 'Session processing failed' });
  }
});

/**
 * POST /api/outbound
 * Triggers an outbound Twilio call
 */
app.post('/api/outbound', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!twilioClient) {
    return res.status(500).json({ error: 'Twilio is not configured on the server.' });
  }

  if (!phoneNumber) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  const host = req.get('host');
  const url = `https://${host}/incoming`;

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: phoneNumber,
      url: url,
    });

    serverLog.info('Outbound call triggered', { callSid: call.sid, to: phoneNumber });
    res.json({ success: true, callSid: call.sid });
  } catch (error) {
    serverLog.error('Failed to trigger outbound call', error);
    res.status(500).json({ error: error.message });
  }
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
  let callSid = null; // Track Twilio CallSid for hangups
  let interruptionManager = null;
  let silenceFiller = null;
  let currentProcessingId = 0;
  let isProcessingTranscript = false;
  let fastMatchProcessedThisTurn = false;

  // Create call-scoped logger (will get streamSid and callerPhone later)
  let callLog = Logger.forCall(callId, null, null);

  callLog.withComponent('WS').info('WebSocket connection accepted');

  let audioPacketCount = 0;
  ws.on('message', async (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    if (msg.event === 'start') {
      const streamSid = msg.start.streamSid;
      callSid = msg.start.callSid; // Capture the real CallSid
      const callerPhone = msg.start.customParameters?.caller_phone ?? '';
      activeStreamSid = streamSid;

      // Update logger with full call context
      callLog = Logger.forCall(callId, streamSid, callerPhone);
      const log = callLog.withComponent('WS');

      log.info('Stream starting', { streamSid, callerPhone, asr_provider: ASR_PROVIDER });
      audioPacketCount = 0;

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
          silenceFiller?.pause(); // While agent speaks, hold the silence timer
        },
        onSpeakingEnd: () => {
          interruptionManager.onSpeakingEnd();
          if (!isProcessingTranscript) {
            silenceFiller?.resume(); // Agent finished: restart 7s countdown
          }
        },
      });

      // Transcript handler (shared between ASR providers)
      const onTranscript = async (transcript, audioBuffer = null) => {
        if (!transcript?.trim()) return;
        const myProcessingId = ++currentProcessingId;
        const asrReceivedAt = performance.now();
        callLog.withComponent('Timing').info('ASR final transcript received', { transcript_length: transcript.length });

        try {
          // 1. Immediately pause and reset the silence filler to prevent it firing during processing
          silenceFiller?.reset();
          silenceFiller?.pause();
          isProcessingTranscript = true;

          // --- Background "Burst" Correction ---
          // If we are in GST or Email nodes, send the raw audio to Deepgram REST for a "second opinion" (high accuracy)
          const currentNode = callSession?.getCurrentNode();
          if (audioBuffer && (currentNode === 'NODE_3_CONTACT_GST' || transcript.match(/[A-Z0-9]{10,}/i) || transcript.includes('@'))) {
            Promise.resolve().then(async () => {
              try {
                // Use English or Multi for burst correction in Node 3 to capture alphanumeric correctly
                const burstLang = (currentNode === 'NODE_3_CONTACT_GST') ? 'en' : 'multi';
                const burst = await transcribeAudioBurst(audioBuffer, { language: burstLang });
                if (burst?.transcript && burst.transcript.toLowerCase() !== transcript.toLowerCase()) {
                  callLog.withComponent('Validation').info(`[Burst Correction] REST Result: "${burst.transcript}" (Streaming was: "${transcript}")`);

                  const cleanedBurst = burst.transcript.replace(/[\s\-]/g, '').toUpperCase();
                  const updates = {};

                  // If it looks like a GST (15 chars) - Simply Collect
                  if (cleanedBurst.length === 15 || cleanedBurst.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/)) {
                    updates.gstin = cleanedBurst;
                    updates.gstin_valid = 'yes';
                    callLog.withComponent('Validation').info(`[Burst Success] Collected GSTIN from burst: ${cleanedBurst}`);
                  }
                  // If it looks like an email
                  else if (burst.transcript.includes('@') || burst.transcript.includes(' at ')) {
                    const norm = await normalizeSpokenEmailTool.invoke({ spoken_email: burst.transcript });
                    const parsedNorm = typeof norm === 'string' ? JSON.parse(norm) : norm;
                    const val = await validateEmailTool.invoke({ email: parsedNorm.normalized_email });
                    const parsedVal = typeof val === 'string' ? JSON.parse(val) : val;
                    if (parsedVal.valid || parsedVal.success) {
                      updates.email = parsedVal.normalized || parsedVal.data?.normalized;
                      updates.email_valid = 'yes';
                      callLog.withComponent('Validation').info(`[Burst Success] Corrected Email from burst: ${updates.email}`);
                    }
                  }

                  if (Object.keys(updates).length > 0) {
                    callSession.updateSession(updates);
                  }
                }
              } catch (e) { }
            });
          }
          // --- End Burst Correction ---
          const wasSpeaking = tts?.isSpeaking;
          if (!interruptionManager.shouldProcessTranscript(transcript)) {
            // Even if dropped, it's human voice activity, so reset the 7s countdown
            silenceFiller?.reset();
            return;
          }

          // 2. Barge-in handling
          // clearAudio() stops playback but it synchronously fires onSpeakingEnd -> silenceFiller.resume().
          // Therefore, we must clear AUDIO *BEFORE* we explicitly command the silence filler to pause for the LLM processing.
          if (wasSpeaking && tts) {
            tts.clearAudio();
          }

          // 3. Safely reset and pause the filler for the duration of transcript processing
          silenceFiller?.reset();
          silenceFiller?.pause();
          isProcessingTranscript = true;

          callLog.withComponent('User').info(transcript);
          const timer = callLog.withComponent('Workflow').time('processTranscript');

          // Set the active callback so the agent workflow knows if it should abort streaming
          callSession.setIsActiveCallback(() => {
            return isActive && myProcessingId === currentProcessingId;
          });

          // Pass tts and silenceFiller so the agent workflow can stream text chunks immediately and pause fillers
          const result = await callSession.processTranscript(transcript, tts, silenceFiller);
          callLog.withComponent('Workflow').timeEnd(timer);
          callLog.withComponent('Timing').info('End-to-end pipeline', { total_ms: Math.round(performance.now() - asrReceivedAt), streamed: result.streamedByNode });
          callLog.withComponent('Workflow').debug('Processed result', { say: result.say, next_node: result.next_node, notes: result.notes });


          // Language switching removed to prevent ASR teardown (kills the stream)
          // The LLM now handles Hinglish mixed input naturally.


          // Guard: if a newer transcript arrived while we were waiting, discard this result
          if (myProcessingId !== currentProcessingId) {
            callLog.withComponent('Workflow').warn('Discarding stale result', { myProcessingId, currentProcessingId });
            return;
          }

          const { say, next_node, session, streamedByNode } = result;

          if (say && tts && isActive) {
            callLog.withComponent('Agent').info(say);

            if (!streamedByNode) {
              callLog.withComponent('TTS').warn('LLM stream parser failed to chunk output. Sending fallback full text.');
              await tts.sendText(say);
            }

            // Just trigger a flush to terminate the generation.
            tts.flush();

            // --- Smart Language Switch (Phase 3) ---
            // If we just entered Node 4, switch the ASR to multilingual for better Q&A support.
            // We do this after the bridge TTS starts to hide the reconnection latency.
            if (next_node === 'NODE_4_CLOSURE' && asr && asr.options.language !== 'multi') {
              callLog.withComponent('ASR').info('🚀 Entering QnA Phase — switching ASR to Multilingual mode');
              asr.setLanguage('multi');
            }
          }
          isProcessingTranscript = false;

          if (callSession.isTerminal()) {
            isActive = false;
            callLog.withComponent('Call').info('Call reached terminal node — waiting for TTS to finish before closing', {
              outcome: session.call_outcome,
              node: next_node,
            });

            // Wait for TTS to finish speaking (if it started) then close after a 5s grace period
            const closeAfterSpeaking = () => {
              const checkInterval = setInterval(() => {
                if (!tts.isSpeaking) {
                  clearInterval(checkInterval);
                  callLog.withComponent('Call').info('TTS finished — closing call in 5s');
                  setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.close();
                    // Physically hang up the Twilio call via REST API
                    if (twilioClient && callSid) {
                      twilioClient.calls(callSid).update({ status: 'completed' })
                        .then(() => callLog.info('Twilio call hung up successfully'))
                        .catch(err => callLog.error('Twilio hangup failed', { error: err.message }));
                    }
                  }, 5000);
                }
              }, 500);
            };

            closeAfterSpeaking();
          } else {
            // Processing done, not terminal: Resume silence filler for next gap
            // ONLY if the agent isn't currently speaking or about to speak
            if (!tts?.isSpeaking && !tts?.hasPendingAudio()) {
              silenceFiller?.resume();
            }
          }
        } catch (err) {
          isProcessingTranscript = false;
          callLog.withComponent('WS').error('ASR callback error', err);
          if (!tts?.isSpeaking && !tts?.hasPendingAudio()) {
            silenceFiller?.resume();
          }
        }
      };

      // Create ASR based on configured provider
      const asrOptions = {
        logger: callLog,
        // Ultra-fast barge-in: clear audio instantly on first partial transcript!
        onInterim: (partial) => {
          if (!partial?.trim()) return;

          // Any human voice activity delays the 7s silence timeout!
          silenceFiller?.reset();

          if (isActive && tts && tts.isSpeaking && interruptionManager.shouldProcessTranscript(partial)) {
            currentProcessingId++; // Abort stale generation
            callLog.withComponent('User').info(`[Barge-in] Partial: ${partial}`);
            tts.clearAudio();
            silenceFiller?.pause();
          }

          // Evaluate fast match on partial transcripts — bypass waiting for Deepgram final.
          // IMPORTANT: Call processTranscript directly instead of onTranscript to avoid
          // the race where forceFlush triggers an ASR final that aborts our processing.
          if (callSession && callSession.checkFastMatch && callSession.processTranscript) {
            if (callSession.checkFastMatch(partial) && !fastMatchProcessedThisTurn && !isProcessingTranscript) {
              fastMatchProcessedThisTurn = true;
              callLog.withComponent('User').info(`[Fast-Match Interim] Matched: ${partial}. Bypassing ASR final.`);

              silenceFiller?.reset();
              silenceFiller?.pause();
              isProcessingTranscript = true;

              const myProcId = ++currentProcessingId;
              callSession.setIsActiveCallback(() => isActive && myProcId === currentProcessingId);

              callSession.processTranscript(partial, tts, silenceFiller).then((result) => {
                if (myProcId !== currentProcessingId) {
                  callLog.withComponent('Workflow').warn('[Fast-Match Interim] Result discarded (superseded)');
                  isProcessingTranscript = false;
                  silenceFiller?.resume();
                  return;
                }
                const { say, next_node, session, streamedByNode } = result;
                if (say && tts && isActive) {
                  callLog.withComponent('Agent').info(say);
                  if (!streamedByNode) tts.sendText(say);
                  tts.flush();
                }
                isProcessingTranscript = false;

                if (callSession.isTerminal()) {
                  isActive = false;
                  const checkInterval = setInterval(() => {
                    if (!tts.isSpeaking) {
                      clearInterval(checkInterval);
                      setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 5000);
                    }
                  }, 500);
                } else if (!tts?.isSpeaking && !tts?.hasPendingAudio()) {
                  silenceFiller?.resume();
                }

                // Flush ASR buffer AFTER processing completes to avoid the race condition
                asr?.forceFlush?.();
              }).catch((err) => {
                isProcessingTranscript = false;
                callLog.withComponent('WS').error('[Fast-Match Interim] Processing error', err);
                silenceFiller?.resume();
              });
            }
          }
        },
        onSpeechStarted: () => {
          fastMatchProcessedThisTurn = false;
        }
      };
      if (ASR_PROVIDER === 'deepgram') {
        asrOptions.language = 'hi'; // Phase 3: Start in Hindi for maximum onboarding accuracy
        asr = new DeepgramASR(onTranscript, asrOptions);
      } else {
        asr = new ElevenLabsASR(onTranscript, asrOptions);
      }

      callSession = createCallSession(callerPhone, {
        logger: callLog,
        onSessionUpdate: (updatedSession) => {
          // Log a special message that app.js understands for UI syncing
          callLog.withComponent('Database').info('SESSION_UPDATED', { session: updatedSession });
        }
      });
      if (activeCalls.has(callId)) {
        activeCalls.get(callId).callSession = callSession;
      }

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
          await tts.sendText(welcome);
          tts.flush(); // Flush immediately â€” no setTimeout delay
        }

        // Start silence filler monitoring AFTER welcome is sent
        silenceFiller.init(tts, callSession);
      } catch (err) {
        callLog.withComponent('WS').error('Welcome generation error', err);
      }
    }
    else if (msg.event === 'media') {
      if (isActive) {
        audioPacketCount++;
        if (audioPacketCount % 100 === 0) {
          callLog.withComponent('WS').debug(`Audio packets received: ${audioPacketCount}`);
        }
        asr?.sendAudio(msg.media.payload);
      }
    }
    else if (msg.event === 'stop') {
      // IMPORTANT: Do NOT tear down ASR/TTS here.
      // Twilio can send 'stop' prematurely or for a previous stream.
      // The actual cleanup should only happen on ws.close.
      // If the caller truly hung up, Twilio will also close the WebSocket.
      const stopStreamSid = msg.stop?.streamSid || msg.streamSid || 'unknown';
      const log = callLog.withComponent('WS');

      log.info('Stop command from Twilio', { stopStreamSid, activeStreamSid });

      if (stopStreamSid === activeStreamSid || stopStreamSid === 'unknown') {
        log.info('Stop received — marking inactive, waiting for WS close');
        isActive = false;
        silenceFiller?.stop();
      } else {
        log.debug('Stop is for a different stream â€” ignoring');
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
    currentProcessingId++; // Abort any in-flight processing loops
    silenceFiller?.stop();
    asr?.close();
    tts?.close();

    // Unregister from active calls
    if (callSession) {
      const sess = callSession.getSession();
      if (!sess.call_outcome || sess.call_outcome === 'in_progress') sess.call_outcome = 'complete';
      saveToHistory(sess);
    }
    activeCalls.delete(callId);
    log.info('Call cleanup complete', { callId });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  serverLog.info(`Server listening`, {
    port: PORT,
    buildTag: 'v28-name-first-pitch-fix',
    asr_provider: ASR_PROVIDER,
    default_interruptions: DEFAULT_INTERRUPTIONS_ENABLED,
    silence_filler_timeout_ms: SILENCE_FILLER_TIMEOUT_MS,
  });
});
