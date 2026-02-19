import { WebSocket } from 'ws';

// Correct endpoint for ElevenLabs Scribe v2 Realtime
const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;
            // Only model_id and api_key in query params
            const url = `${ELEVENLABS_WS_URL}?model_id=scribe_v2_realtime&api_key=${apiKey}`;

            this.ws = new WebSocket(url);

            this.ws.on('open', () => {
                console.log('[ASR] WebSocket open, sending handshake...');

                // Send the required handshake/init message as the FIRST message
                const initMessage = {
                    type: 'config',
                    audio_format: 'mulaw_8000',
                    commit_strategy: 'auto',
                    vad_silence_threshold_secs: 1.0,
                    vad_threshold: 0.4,
                    min_speech_duration_ms: 100,
                    min_silence_duration_ms: 300,
                    enable_logging: true
                };
                this.ws.send(JSON.stringify(initMessage));

                this.isReady = true;
                console.log('[ASR] Connected to ElevenLabs Scribe v2 Realtime');
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);

                    // Handle different message types from ElevenLabs STT
                    if (response.type === 'transcript') {
                        const text = (response.data?.text || response.text || '').trim();
                        const isFinal = response.data?.is_final ?? response.is_final ?? false;

                        if (text) {
                            console.log(`[ASR] ${isFinal ? 'FINAL' : 'partial'}: ${text}`);
                            // Only send final transcripts to the agent
                            if (isFinal && this.onTranscript) {
                                this.onTranscript(text);
                            }
                        }
                    } else if (response.type === 'error') {
                        console.error('[ASR] Server error:', response.message || JSON.stringify(response));
                    } else if (response.type === 'config_ack' || response.type === 'ready') {
                        console.log('[ASR] Config acknowledged, ready for audio');
                    } else {
                        // Log unknown message types for debugging
                        console.log('[ASR] Message:', JSON.stringify(response).substring(0, 200));
                    }
                } catch (err) {
                    console.error('[ASR] Failed to parse message:', err.message);
                }
            });

            this.ws.on('error', (err) => {
                console.error('[ASR] Error:', err.message);
                this.isReady = false;
                resolve(); // resolve anyway so we don't hang
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[ASR] Disconnected (code=${code}, reason=${reason})`);
                this.isReady = false;
                resolve();
            });
        });
    }

    /**
     * Send a base64-encoded mulaw audio chunk to ElevenLabs.
     * @param {string} base64Audio 
     */
    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            // ElevenLabs expects audio as a JSON message with base64 audio
            this.ws.send(JSON.stringify({
                type: 'audio',
                audio: base64Audio
            }));
        }
    }

    /**
     * Wait for the ASR connection to be ready.
     */
    async waitReady() {
        await this._connectPromise;
    }

    close() {
        this.isReady = false;
        if (this.ws?.readyState === WebSocket.OPEN) {
            // Send end-of-stream signal
            try {
                this.ws.send(JSON.stringify({ type: 'eos' }));
            } catch { }
            this.ws.close();
        }
    }
}
