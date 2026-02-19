import { WebSocket } from 'ws';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 * 
 * KEY FIX (v16):
 * ElevenLabs Scribe v2 Realtime uses a **JSON-based protocol**, NOT raw binary.
 * Audio must be sent as:
 *   { "message_type": "input_audio_chunk", "audio_base_64": "...", "sample_rate": 8000 }
 * 
 * Previous versions were sending raw binary Buffers which ElevenLabs rejected immediately.
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._keepaliveInterval = null;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._closed) return resolve();

            const apiKey = process.env.ELEVENLABS_API_KEY;

            // CRITICAL: Specify audio_format in the connection URL.
            // Twilio sends μ-law 8kHz audio, so we MUST tell ElevenLabs.
            // Default is pcm_16000 which causes silent/garbled transcription.
            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000',
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            console.log(`[ASR] Connecting... (attempt ${this._reconnectAttempts + 1})`);

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            let resolved = false;
            const safeResolve = () => {
                if (!resolved) { resolved = true; resolve(); }
            };

            const timeout = setTimeout(() => {
                if (!resolved) {
                    console.warn('[ASR] Timed out waiting for session_started (10s)');
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.isReady = true;
                    }
                    safeResolve();
                }
            }, 10000);

            this.ws.on('open', () => {
                console.log('[ASR] WebSocket open, waiting for session_started...');
                this._reconnectAttempts = 0;
            });

            this.ws.on('message', (data) => {
                try {
                    const text = Buffer.isBuffer(data) ? data.toString() : data;
                    const response = JSON.parse(text);
                    const msgType = response.type || response.message_type;

                    if (msgType === 'session_started') {
                        console.log('[ASR] Session started by server');
                        this.isReady = true;
                        clearTimeout(timeout);
                        this._startKeepalive();
                        safeResolve();
                    } else if (msgType === 'transcript' || msgType === 'committed_transcript' || msgType === 'final_transcript') {
                        const transcript = (response.transcript || response.text || '').trim();
                        if (transcript && this.onTranscript) {
                            console.log(`[ASR] ${msgType.toUpperCase()}: ${transcript}`);
                            this.onTranscript(transcript);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const transcript = (response.transcript || response.text || '').trim();
                        if (transcript) console.log(`[ASR] partial: ${transcript}`);
                    } else if (msgType === 'error' || response.error) {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    } else {
                        // Log any other message types for debugging
                        console.log(`[ASR] Received msg type: ${msgType}`);
                    }
                } catch (err) {
                    // Not JSON, ignore
                }
            });

            this.ws.on('error', (err) => {
                console.error('[ASR] WebSocket Error:', err.message);
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                console.log(`[ASR] Disconnected (code=${code}, reason=${reasonStr})`);
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);

                if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    console.log(`[ASR] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);
                    setTimeout(() => {
                        if (!this._closed) {
                            this._connectPromise = this._connect();
                        }
                    }, delay);
                } else if (!this._closed) {
                    console.error(`[ASR] Max reconnect attempts (${this._maxReconnectAttempts}) exhausted`);
                }

                safeResolve();
            });
        });
    }

    /**
     * Send keepalive silence to prevent idle disconnect.
     * Uses the JSON protocol: sends a silent audio chunk.
     */
    _startKeepalive() {
        this._stopKeepalive();
        // Generate 160 bytes of μ-law silence (0xFF) as base64
        const silenceBase64 = Buffer.alloc(160, 0xFF).toString('base64');
        this._keepaliveInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
                this.ws.send(JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: silenceBase64,
                    sample_rate: 8000
                }));
            }
        }, 5000);
    }

    _stopKeepalive() {
        if (this._keepaliveInterval) {
            clearInterval(this._keepaliveInterval);
            this._keepaliveInterval = null;
        }
    }

    /**
     * Send audio to ElevenLabs ASR.
     * @param {string} base64Audio - Base64-encoded μ-law 8kHz audio from Twilio
     */
    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            if (!base64Audio) return;

            // Send as JSON with the correct message format
            this.ws.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64Audio,
                sample_rate: 8000
            }));
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    close() {
        this._closed = true;
        this.isReady = false;
        this._stopKeepalive();
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'call_ended');
        }
    }
}
