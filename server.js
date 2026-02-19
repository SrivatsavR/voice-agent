import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
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
  console.log('[Health] Root hit');
  res.send('Voice AI Platform is running!');
});

app.post('/incoming', (req, res) => {
  const caller = req.body.From || 'unknown';
  console.log(`[Twilio] Incoming call from: ${caller}`);

  // Log all relevant headers to see what Railway's proxy is providing
  console.log(`[Twilio] Headers: host=${req.headers.host}, x-forwarded-host=${req.headers['x-forwarded-host']}, hostname=${req.hostname}`);

  // Use req.hostname to avoid any internal port issues from req.headers.host
  const host = req.hostname;
  const streamUrl = `wss://${host}/media-stream`;
  console.log(`[Twilio] Returning Stream URL: ${streamUrl}`);

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
  console.log(`[HTTP] Upgrade request for ${pathname} from ${request.headers.host}`);

  if (pathname === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    console.log(`[HTTP] Rejecting upgrade for ${pathname}`);
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

        // Initialize TTS and ASR — start connections in parallel
        tts = new ElevenLabsTTS(ws, streamSid);
        asr = new ElevenLabsASR(async (transcript) => {
          try {
            if (!transcript?.trim() || !isActive) return;
            console.log(`[ASR] Transcript: "${transcript}"`);

            if (!callSession) {
              console.warn('[ASR] Received transcript before session fully initialized.');
              return;
            }

            const prevNode = callSession.getCurrentNode();
            const { say, next_node, session } = await callSession.processTranscript(transcript);
            console.log(`[Workflow] ${prevNode} → ${next_node} | Say: ${say}`);

            if (say && tts && isActive) {
              tts.sendText(say);
            }

            if (callSession.isTerminal()) {
              isActive = false;
              console.log(`[Terminal] outcome=${session.call_outcome} | node=${next_node}`);
              setTimeout(() => {
                console.log('[WS] Closing due to terminal state');
                if (ws.readyState === ws.OPEN) ws.close();
              }, 7000);
            }
          } catch (err) {
            console.error('[ASR Callback Error]', err);
          }
        });

        // Initialize the agent session
        callSession = createCallSession(callerPhone);

        // Wait for services
        const welcomeText = "Hello, thank you for calling Meesho. This is the reseller onboarding team.";

        try {
          const initTimeout = new Promise((_, reject) => setTimeout(() => reject('Timeout'), 5000));
          await Promise.race([
            Promise.all([tts.waitReady(), asr.waitReady()]),
            initTimeout
          ]).catch(e => console.warn('[WS] Service init slow/failed, proceeding anyway...'));

          console.log(`[Welcome] ${welcomeText}`);
          if (tts && isActive) tts.sendText(welcomeText);
        } catch (err) {
          console.error('[Welcome Error]', err);
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
    if (callSession) {
      console.log('[Final Session State]', JSON.stringify(callSession.getSession(), null, 2));
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('[Server] Startup Diagnostic:');
const openAiKey = process.env.OPENAI_API_KEY || '';
const elKey = process.env.ELEVENLABS_API_KEY || '';
console.log(`  - OpenAI Key: ${openAiKey ? 'Present (' + openAiKey.substring(0, 7) + '...)' : 'MISSING'}`);
console.log(`  - ElevenLabs Key: ${elKey ? 'Present (' + elKey.substring(0, 7) + '...)' : 'MISSING'}`);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on 0.0.0.0:${PORT} [Build Tag: Fixed-ASR-Protocol-v7-Final]`);
});

// Global Error Handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Fatal] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught Exception:', err);
});
