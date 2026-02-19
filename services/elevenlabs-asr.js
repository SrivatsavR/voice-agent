import { WebSocket } from 'ws';

const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/stream-input';

/**
 * Manages the WebSocket connection to ElevenLabs ASR.
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
        this.ws = new WebSocket(
            `${ELEVENLABS_WS_URL}?model_id=scribe_v1&api_key=${apiKey}`
        );

        this.ws.on('open', () => {
            console.log('[ASR] Connected to ElevenLabs');
        });

        this.ws.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (response.text && this.onTranscript) {
                    this.onTranscript(response.text);
                }
            } catch (err) {
                console.error('[ASR] Failed to parse message:', err);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[ASR] Error:', err.message);
        });

        this.ws.on('close', () => {
            console.log('[ASR] Disconnected');
        });
    }

    /**
     * Send a base64-encoded mulaw audio chunk to ElevenLabs.
     * @param {string} base64Audio 
     */
    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                audio: base64Audio,
                sample_rate: 8000,
                encoding: 'ulaw'
            }));
        }
    }

    close() {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }
}
