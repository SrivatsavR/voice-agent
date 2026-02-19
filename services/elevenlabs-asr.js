import { WebSocket } from 'ws';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 * 
 * KEY FIXES (v14):
 * - Wait for 'session_started' message before resolving readiness (not just 'open')
 * - Add auto-reconnect on unexpected disconnects
 * - Don't send empty buffer on close (ElevenLabs treats it as EOS signal)
 * - Add keepalive ping to prevent idle timeouts
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._closed = false;   // True when intentionally closed
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._keepaliveInterval = null;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve, reject) => {
            if (this._closed) return resolve();

            const apiKey = process.env.ELEVENLABS_API_KEY;

            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000'
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            let resolved = false;
            const safeResolve = () => {
                if (!resolved) { resolved = true; resolve(); }
            };

            // Timeout: if we don't get session_started within 10s, resolve anyway
            const timeout = setTimeout(() => {
                if (!resolved) {
                    console.warn('[ASR] Timed out waiting for session_started, resolving anyway');
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.isReady = true;  // Assume ready if socket is open
                    }
                    safeResolve();
                }
            }, 10000);

            this.ws.on('open', () => {
                console.log('[ASR] Connected to ElevenLabs Scribe V2 Realtime');
                this._reconnectAttempts = 0;
                // DON'T resolve yet — wait for session_started
                // But DO start keepalive pings
                this._startKeepalive();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    const msgType = response.type || response.message_type;

                    if (msgType === 'session_started') {
                        console.log('[ASR] Session started by server');
                        this.isReady = true;
                        clearTimeout(timeout);
                        safeResolve();
                    } else if (msgType === 'transcript' || msgType === 'committed_transcript' || msgType === 'final_transcript') {
                        const text = (response.transcript || response.text || '').trim();
                        if (text && this.onTranscript) {
                            console.log(`[ASR] ${msgType.toUpperCase()}: ${text}`);
                            this.onTranscript(text);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const text = (response.transcript || response.text || '').trim();
                        if (text) console.log(`[ASR] partial: ${text}`);
                    } else if (msgType === 'error' || response.error) {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    }
                } catch (err) {
                    // Ignore binary or unparseable messages
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

                // If this was NOT intentional and we haven't exhausted retries, reconnect
                if (!this._closed && code !== 1000 && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    console.log(`[ASR] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);
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

    /**
     * Send periodic silence/ping to keep the connection alive.
     * ElevenLabs may disconnect on idle — sending small silence frames prevents this.
     */
    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                // Send 160 bytes of silence (μ-law silence = 0xFF, 20ms at 8kHz)
                const silence = Buffer.alloc(160, 0xFF);
                this.ws.send(silence);
            }
        }, 5000); // every 5 seconds
    }

    _stopKeepalive() {
        if (this._keepaliveInterval) {
            clearInterval(this._keepaliveInterval);
            this._keepaliveInterval = null;
        }
    }

    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            if (!base64Audio) return;
            const buffer = Buffer.from(base64Audio, 'base64');
            if (buffer.length === 0) return;

            // Scribe V2 Realtime expects raw binary audio frames
            this.ws.send(buffer);
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
            // Just close cleanly — do NOT send empty buffer (ElevenLabs treats it as EOS+close)
            this.ws.close(1000, 'call_ended');
        }
    }
}
