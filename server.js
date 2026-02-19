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

app.get('/', (req, res) => {
  res.send('Voice AI Platform is running! [v8-Final-Stability]');
});

app.post('/incoming', (req, res) => {
  const caller = req.body.From || 'unknown';
  console.log(`[Twilio] Incoming call from: ${caller}`);
  const host = req.hostname;
  const streamUrl = `wss://${host}/media-stream`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${streamUrl}">
            <Parameter name="caller_phone" value="${caller}" />
        </Stream>
    </Connect>
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
  console.log('[WS] New Twilio connection established');

  let asr = null;
  let tts = null;
  let callSession = null;
  let isActive = true;
  let ignoreAsrUntil = 0; // Timestamp to prevent echo/self-interruption

  ws.on('message', async (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'start': {
        const streamSid = msg.start.streamSid;
        const callerPhone = msg.start.customParameters?.caller_phone ?? '';
        console.log(`[WS] Stream started: ${streamSid}`);

        // Initialize Services
        tts = new ElevenLabsTTS(ws, streamSid);
        asr = new ElevenLabsASR(async (transcript) => {
          try {
            if (!transcript?.trim() || !isActive) return;

            // Self-Interruption Guard: If we JUST started speaking the welcome, ignore ASR echos
            if (Date.now() < ignoreAsrUntil) {
              console.log(`[ASR] Ignoring echoed transcript: "${transcript}"`);
              return;
            }

            console.log(`[User] ${transcript}`);

            const prevNode = callSession.getCurrentNode();
            const { say, next_node, session } = await callSession.processTranscript(transcript);
            console.log(`[Workflow] ${prevNode} → ${next_node} | say length: ${say?.length || 0}`);

            if (say && tts && isActive) {
              tts.sendText(say);
            }

            if (callSession.isTerminal()) {
              isActive = false;
              console.log(`[Terminal] outcome=${session.call_outcome} | node=${next_node}`);
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) ws.close();
              }, 7000);
            }
          } catch (err) {
            console.error('[ASR Callback Error]', err);
          }
        });

        // Initialize Workflow
        callSession = createCallSession(callerPhone);

        try {
          // Wait for connections with a 5s limit
          const initTimeout = new Promise((_, reject) => setTimeout(() => reject('Init Timeout'), 5000));
          await Promise.race([
            Promise.all([tts.waitReady(), asr.waitReady()]),
            initTimeout
          ]).catch(e => console.warn('[WS] Service init slow, trying anyway...'));

          // Get welcome text (proper state machine start)
          const welcome = await callSession.getWelcome();
          console.log(`[Welcome] ${welcome}`);

          if (tts && isActive) {
            // Set lock for 6 seconds (roughly length of welcome message) to prevent echo interference
            ignoreAsrUntil = Date.now() + 6000;
            tts.sendText(welcome);
          }
        } catch (err) {
          console.error('[Welcome Init Error]', err);
        }

        break;
      }

      case 'media': {
        if (isActive) asr?.sendAudio(msg.media.payload);
        break;
      }

      case 'stop': {
        console.log('[WS] Stream stopped by Twilio');
        isActive = false;
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
    isActive = false;
    asr?.close();
    tts?.close();
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on 0.0.0.0:${PORT} [Build Tag: v10-Crisp-Audio-Final]`);
});

process.on('unhandledRejection', (reason) => console.error('[Fatal Rejection]', reason));
process.on('uncaughtException', (err) => console.error('[Fatal Exception]', err));
