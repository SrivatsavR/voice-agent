import 'dotenv/config';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { ElevenLabsASR } from './services/elevenlabs-asr.js';
import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import { createCallSession } from './services/agent-workflow.js';

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Twilio Webhook ───────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send('Voice AI Platform Active [v17]'));

app.post('/incoming', (req, res) => {
  const caller = req.body.From || 'unknown';
  const host = req.hostname;
  const streamUrl = `wss://${host}/media-stream`;

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
  let asr = null;
  let tts = null;
  let callSession = null;
  let isActive = true;
  let ignoreAsrUntil = 0;
  let activeStreamSid = null;  // Track which stream is active

  console.log('[WS] Connection accepted');

  ws.on('message', async (message) => {
    let msg;
    try { msg = JSON.parse(message); } catch { return; }

    if (msg.event === 'start') {
      const streamSid = msg.start.streamSid;
      const callerPhone = msg.start.customParameters?.caller_phone ?? '';
      activeStreamSid = streamSid;
      console.log(`[WS] Stream starting: ${streamSid}`);

      tts = new ElevenLabsTTS(ws, streamSid);
      asr = new ElevenLabsASR(async (transcript) => {
        try {
          if (!transcript?.trim() || !isActive) return;
          if (Date.now() < ignoreAsrUntil) return; // Mute agent's own voice (echo)

          console.log(`[User] ${transcript}`);
          const result = await callSession.processTranscript(transcript);
          const { say, next_node, session } = result;

          if (say && tts && isActive) {
            console.log(`[Agent] ${say}`);
            tts.sendText(say);
            setTimeout(() => { if (isActive) tts.flush(); }, 100);
          }

          if (callSession.isTerminal()) {
            isActive = false;
            console.log(`[Terminal] outcome=${session.call_outcome}`);
            setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.close(); }, 5000);
          }
        } catch (err) { console.error('[ASR Callback Error]', err); }
      });

      callSession = createCallSession(callerPhone);

      try {
        // Wait for service handshakes
        await Promise.all([tts.waitReady(), asr.waitReady()]);
        console.log('[WS] Services ready');

        const welcome = await callSession.getWelcome();
        console.log(`[Welcome] ${welcome}`);
        if (tts && isActive) {
          ignoreAsrUntil = Date.now() + 6000;
          tts.sendText(welcome);
          setTimeout(() => { if (isActive) tts.flush(); }, 100);
        }
      } catch (err) { console.error('[Welcome Error]', err); }
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
      console.log(`[WS] Stop command from Twilio (streamSid=${stopStreamSid}, active=${activeStreamSid})`);

      // Only mark inactive if this stop is for our active stream
      if (stopStreamSid === activeStreamSid) {
        console.log('[WS] Stop is for active stream — marking inactive, waiting for WS close');
        isActive = false;
        // Do NOT close ASR/TTS here — let the ws.close handler do it.
        // This prevents premature teardown if the stop arrives early.
      } else {
        console.log('[WS] Stop is for a different/unknown stream — ignoring');
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed — cleaning up all services');
    isActive = false;
    asr?.close();
    tts?.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on 0.0.0.0:${PORT} [Build Tag: v17-Stop-Event-Fix]`);
});
