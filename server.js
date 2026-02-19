import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import bodyParser from 'body-parser';
import { ElevenLabsASR } from './services/elevenlabs-asr.js';
import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import { createCallSession } from './services/agent-workflow.js';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Twilio Webhook ───────────────────────────────────────────────────────────

app.post('/incoming', (req, res) => {
  console.log('[Twilio] Incoming call');
  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.headers.host}/media-stream" />
      </Connect>
    </Response>
  `);
});

// ─── WebSocket (Media Stream) ─────────────────────────────────────────────────

wss.on('connection', (ws) => {
  console.log('[WS] New Twilio connection');

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

        // Initialize TTS first so it can connect while welcome runs
        tts = new ElevenLabsTTS(ws, streamSid);

        // Initialize the agent session
        callSession = createCallSession(callerPhone);

        // Initialize ASR — transcripts feed through the node state machine
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
            tts.flush();
          }

          // Handle terminal nodes — log session and hang up after TTS drains
          if (callSession.isTerminal()) {
            console.log(`\n[Call ended] outcome=${session.call_outcome} | node=${next_node}`);
            console.log('[Final Session]', JSON.stringify(session, null, 2));
            setTimeout(() => ws.close(), 4000);
          }
        });

        // Speak the welcome line
        try {
          const welcomeText = await callSession.getWelcome();
          console.log(`[Welcome] ${welcomeText}`);
          if (tts && welcomeText) {
            tts.sendText(welcomeText);
            tts.flush();
          }
        } catch (err) {
          console.error('[Welcome] Agent error:', err);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
});
