import { WebSocket } from 'ws';

/**
 * ElevenLabs TTS (Rachel / Flash v2.5 / Mulaw 8kHz)
 * 
 * KEY FIXES (v14):
 * - Proper connection lifecycle with explicit state tracking
 * - Better heartbeat that sends proper flush signals
 * - Reconnect support for dropped connections
 * - Proper close sequence (flush → EOS → close)
 */
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'ulaw_8000';

export class ElevenLabsTTS {
    constructor(twilioWs, streamSid) {
        this.twilioWs = twilioWs;
        this.streamSid = streamSid;
        this.ws = null;
        this.isReady = false;
        this._closed = false;   // True when intentionally closed
        this._heartbeatInterval = null;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._closed) return resolve();

            const apiKey = process.env.ELEVENLABS_API_KEY;

            // max inactivity_timeout = 180s
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}&inactivity_timeout=180`;

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            let resolved = false;
            const safeResolve = () => {
                if (!resolved) { resolved = true; resolve(); }
            };

            // Timeout: resolve after 10s even if not connected
            const timeout = setTimeout(() => {
                console.warn('[TTS] Connection timed out after 10s');
                safeResolve();
            }, 10000);

            this.ws.on('open', () => {
                this.isReady = true;
                console.log('[TTS] Connected');

                // Initialize with BOS (Beginning of Stream) message
                // Minimum allowed chunk_length_schedule item is 50
                this.ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                    generation_config: { chunk_length_schedule: [50] }
                }));

                this._reconnectAttempts = 0;
                this._startHeartbeat();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('message', (data) => {
                try {
                    // ElevenLabs can send audio as raw binary OR as JSON with base64 'audio' field
                    if (Buffer.isBuffer(data)) {
                        // Check if it's JSON hidden in a Buffer
                        const text = data.toString();
                        if (text.startsWith('{')) {
                            const response = JSON.parse(text);
                            if (response.audio) this._sendToTwilio(response.audio);
                            if (response.error) console.error('[TTS] Server error:', response.error);
                            if (response.isFinal) {
                                console.log('[TTS] Generation complete (isFinal)');
                            }
                        } else {
                            // Raw binary audio frame
                            this._sendToTwilio(data.toString('base64'));
                        }
                    } else if (typeof data === 'string' && data.startsWith('{')) {
                        const response = JSON.parse(data);
                        if (response.audio) this._sendToTwilio(response.audio);
                        if (response.error) console.error('[TTS] Server error:', response.error);
                        if (response.isFinal) {
                            console.log('[TTS] Generation complete (isFinal)');
                        }
                    }
                } catch (err) {
                    // Ignore parse errors
                }
            });

            this.ws.on('error', (err) => {
                console.error('[TTS] Error:', err.message);
                this.isReady = false;
                this._stopHeartbeat();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                console.log(`[TTS] Closed (code=${code}, reason=${reasonStr})`);
                this.isReady = false;
                this._stopHeartbeat();
                clearTimeout(timeout);

                // Auto-reconnect on unexpected close
                if (!this._closed && code !== 1000 && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    console.log(`[TTS] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);
                    setTimeout(() => {
                        if (!this._closed) {
                            this._connectPromise = this._connect();
                        }
                    }, delay);
                }

                safeResolve();
            });
        });
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        // Send heartbeat every 15s to keep connection alive
        this._heartbeatInterval = setInterval(() => {
            if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify({ text: " " }));
                } catch (err) {
                    console.error('[TTS] Heartbeat send error:', err.message);
                }
            }
        }, 15000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    sendText(text) {
        if (this.isReady && text && this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                text: text + " ",
                try_trigger_generation: true
            }));
        } else {
            console.warn(`[TTS] Cannot send text — ready=${this.isReady}, wsState=${this.ws?.readyState}`);
        }
    }

    /**
     * Trigger generation for the current buffer without closing the connection
     */
    flush() {
        if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
            // Sending empty text with flush=true tells ElevenLabs to generate now
            this.ws.send(JSON.stringify({
                text: " ",
                try_trigger_generation: true,
                flush: true
            }));
        }
    }

    _sendToTwilio(audioBase64) {
        if (!audioBase64 || audioBase64.length === 0) return;
        if (this.twilioWs.readyState === WebSocket.OPEN) {
            this.twilioWs.send(JSON.stringify({
                event: 'media',
                streamSid: this.streamSid,
                media: { payload: audioBase64 }
            }));
        }
    }

    close() {
        this._closed = true;
        this.isReady = false;
        this._stopHeartbeat();
        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                // Send proper EOS (End of Stream) signal
                this.ws.send(JSON.stringify({ text: "" }));
            } catch { }
            // Give ElevenLabs a moment to process, then close
            setTimeout(() => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.close(1000, 'call_ended');
                }
            }, 500);
        }
    }
}
