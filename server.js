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
          if (!transcript?.trim()) return;
          console.log(`[User] ${transcript}`);

          const prevNode = callSession.getCurrentNode();
          const { say, next_node, notes, session } = await callSession.processTranscript(transcript);
          console.log(`[Agent] ${prevNode} → ${next_node} | ${say}`);
          if (notes) console.log(`  ↳ notes: ${notes}`);

          // Speak the agent's response
          if (say && tts) {
            tts.sendText(say);
          }

          // Handle terminal nodes — log session and hang up after TTS drains
          if (callSession.isTerminal()) {
            console.log(`\n[Call ended] outcome=${session.call_outcome} | node=${next_node}`);
            console.log('[Final Session]', JSON.stringify(session, null, 2));
            setTimeout(() => ws.close(), 4000);
          }
        });

        // Initialize the agent session
        callSession = createCallSession(callerPhone);

        // Wait for TTS + ASR connections AND the welcome text in parallel
        // Added a 5s timeout to prevent the call from hanging indefinitely if a service is slow.
        const initTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Service initialization timed out')), 5000)
        );

        try {
          const [welcomeText] = await Promise.race([
            Promise.all([
              callSession.getWelcome(),
              tts.waitReady(),
              asr.waitReady()
            ]),
            initTimeout
          ]);

          // Now TTS is guaranteed ready — speak the welcome
          console.log(`[Welcome] ${welcomeText}`);
          if (tts && welcomeText) {
            tts.sendText(welcomeText);
          }
        } catch (err) {
          console.error(`[WS] Initialization failed: ${err.message}`);
          // Still try to send welcome if callSession got it, but it might fail if TTS isn't ready
          const welcome = await callSession.getWelcome().catch(() => 'Hello, thank you for calling.');
          if (tts) tts.sendText(welcome);
        }

        break;
      }

      case 'media': {
        // Forward raw mulaw audio from Twilio to ElevenLabs ASR
        asr?.sendAudio(msg.media.payload);
        break;
      }

      case 'stop': {
        console.log('[WS] Stream stopped');
        asr?.close();
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log('[WS] Connection closed');
    asr?.close();
    tts?.close();

    if (callSession) {
      const session = callSession.getSession();
      console.log('[Final Session]', JSON.stringify(session, null, 2));
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('[Server] Checking API Keys...');
const openAiKey = process.env.OPENAI_API_KEY || '';
const elKey = process.env.ELEVENLABS_API_KEY || '';

console.log(`  - OpenAI Key: ${openAiKey ? 'Present (startsWith ' + openAiKey.substring(0, 3) + ')' : 'MISSING'}`);
console.log(`  - ElevenLabs Key: ${elKey ? 'Present (startsWith ' + elKey.substring(0, 3) + ')' : 'MISSING'}`);

if (elKey.startsWith('sk_') || elKey.startsWith('sk-')) {
  console.warn('  ⚠️ WARNING: ELEVENLABS_API_KEY starts with \"sk_\". This usually looks like an OpenAI key.');
  console.warn('  If your ElevenLabs API is failing with 401/403, please check your environment variables.');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Listening on 0.0.0.0:${PORT} [Build Path: Fixed-ASR-Protocol-v5]`);
});
