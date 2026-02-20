import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { ElevenLabsASR } from './services/elevenlabs-asr.js';
import { DeepgramASR } from './services/deepgram-asr.js';
import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import { createCallSession } from './services/agent-workflow.js';
import { generateContextualFiller } from './services/silence-filler-llm.js';
import { Logger, serverLog, wsLog, generateCallId } from './utils/logger.js';
import { InterruptionManager } from './utils/interruption-manager.js';

// detect silence after 7s
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
    this._prepareTimer = null;
    this._fireTimer = null;
    this._tts = null;
    this._callSession = null;
    this._active = false;
    this._paused = false;
    this._preparedPhrase = null;
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
    this._preparedPhrase = null;

    if (this._paused) return;

    // 1. Prepare phrase early at 4s (using LLM) to avoid latency issues
    this._prepareTimer = setTimeout(() => this._prepare(), 4000);
    // 2. Actually fire it and send to TTS at 7s
    this._fireTimer = setTimeout(() => this._fire(), 7000);
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
    if (this._prepareTimer) {
      clearTimeout(this._prepareTimer);
      this._prepareTimer = null;
    }
    if (this._fireTimer) {
      clearTimeout(this._fireTimer);
      this._fireTimer = null;
    }
  }

  async _prepare() {
    if (!this._active || this._paused || this._tts?.isSpeaking) return;

    try {
      const session = this._callSession?.getSession();
      if (!session) return;

      // LLM generation takes ~500-1000ms
      const phrase = await generateContextualFiller(session, this._log);

      // Re-verify state after await
      if (!this._active || this._paused || this._tts?.isSpeaking) return;

      this._preparedPhrase = phrase;
      this._log.info('Prepared silence filler phrase at 4s', { phrase: this._preparedPhrase });
    } catch (err) {
      this._log.error('Failed to prepare LLM filler', err);
    }
  }

  async _fire() {
    if (!this._active || this._paused || !this._tts) return;

    if (this._tts.isSpeaking) {
      this.reset();
      return;
    }

    let phrase = this._preparedPhrase;

    // Wait slightly if the LLM is still preparing the phrase
    if (!phrase) {
      try {
        const session = this._callSession?.getSession();
        if (session) {
          phrase = await generateContextualFiller(session, this._log);
        }
      } catch (e) {
        this._log.error('Fallback LLM filler failed', e);
      }
    }

    // Double-check speaking state after potential await
    if (!this._active || this._paused || this._tts?.isSpeaking || !phrase) return;

    // Final safety check: is TTS still connected and ready?
    if (this._tts.isReady && this._tts.ws?.readyState === WebSocket.OPEN) {
      this._log.info('Firing silence filler phrase at 7s', { phrase });
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

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// â”€â”€â”€ Determine ASR provider from env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'deepgram').toLowerCase();
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
  let currentProcessingId = 0;

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
          silenceFiller?.pause(); // While agent speaks, hold the silence timer
        },
        onSpeakingEnd: () => {
          interruptionManager.onSpeakingEnd();
          silenceFiller?.resume(); // Agent finished: restart 7s countdown
        },
      });

      // Transcript handler (shared between ASR providers)
      const onTranscript = async (transcript) => {
        try {
          if (!transcript?.trim() || !isActive) return;

          const myProcessingId = ++currentProcessingId;

          // 1. Interruption gate check
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

          callLog.withComponent('User').info(transcript);
          const timer = callLog.withComponent('Workflow').time('processTranscript');

          // Set the active callback so the agent workflow knows if it should abort streaming
          callSession.setIsActiveCallback(() => {
            return isActive && myProcessingId === currentProcessingId;
          });

          // Pass tts so the agent workflow can stream text chunks immediately
          const result = await callSession.processTranscript(transcript, tts);
          callLog.withComponent('Workflow').timeEnd(timer);

          // Guard: if a newer transcript arrived while we were waiting, discard this result
          if (myProcessingId !== currentProcessingId) {
            callLog.withComponent('Workflow').warn('Discarding stale result', { myProcessingId, currentProcessingId });
            return;
          }

          const { say, next_node, session } = result;

          if (say && tts && isActive) {
            callLog.withComponent('Agent').info(say);
            // We still send the full say at the end just in case the streaming missed anything
            // and trigger a flush.
            await tts.sendText(say);
            tts.flush();
          }

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
                  }, 5000);
                }
              }, 500);
            };

            closeAfterSpeaking();
          } else {
            // Processing done, not terminal: Resume silence filler for next gap
            silenceFiller?.resume();
          }
        } catch (err) {
          callLog.withComponent('WS').error('ASR callback error', err);
          silenceFiller?.resume();
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
            callLog.withComponent('User').info(`[Barge-in] Partial: ${partial}`);
            tts.clearAudio();
            silenceFiller?.pause();
          }
        }
      };
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
    buildTag: 'v22-interruptions-filler-overlap-fix',
    asr_provider: ASR_PROVIDER,
    default_interruptions: DEFAULT_INTERRUPTIONS_ENABLED,
    silence_filler_timeout_ms: SILENCE_FILLER_TIMEOUT_MS,
  });
});
