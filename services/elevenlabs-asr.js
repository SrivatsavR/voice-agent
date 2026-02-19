import { WebSocket } from 'ws';

// Correct endpoint: /v1/speech-to-text/realtime with scribe_v2_realtime model
const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this._connect();
    }

    _connect() {
        const apiKey = process.env.ELEVENLABS_API_KEY;
        const url = `${ELEVENLABS_WS_URL}?model_id=scribe_v2_realtime&api_key=${apiKey}&encoding=mulaw&sample_rate=8000`;

        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log('[ASR] Connected to ElevenLabs Scribe v2 Realtime');
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                // Scribe realtime sends transcription events
                // Look for final/partial transcript text
                if (response.type === 'transcript' && response.data?.text) {
                    const text = response.data.text.trim();
                    if (text && this.onTranscript) {
                        console.log(`[ASR] Transcript (${response.data.is_final ? 'final' : 'partial'}): ${text}`);
                        // Only route final transcripts to the agent
                        if (response.data.is_final) {
                            this.onTranscript(text);
                        }
                    }
                } else if (response.text) {
                    // Fallback for simpler response format
                    const text = response.text.trim();
                    if (text && this.onTranscript) {
                        this.onTranscript(text);
                    }
                }
            } catch (err) {
                console.error('[ASR] Failed to parse message:', err);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[ASR] Error:', err.message);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[ASR] Disconnected (code=${code}, reason=${reason})`);
        });
    }

    /**
     * Send a base64-encoded mulaw audio chunk to ElevenLabs.
     * @param {string} base64Audio 
     */
    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            // Send raw base64 audio as binary-compatible message
            this.ws.send(JSON.stringify({
                audio: base64Audio
            }));
        }
    }

    close() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
