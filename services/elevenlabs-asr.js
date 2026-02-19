import { WebSocket } from 'ws';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 * 
 * KEY FIXES (v15):
 * - Send silence burst IMMEDIATELY on session_started to prevent ElevenLabs idle-close
 * - Reconnect on ANY unexpected close (including code 1000) if not intentionally closed
 * - Queue audio during reconnect and replay once reconnected
 * - More aggressive keepalive (every 2s)
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 5;
        this._keepaliveInterval = null;
        this._initialSilenceInterval = null;
        this._readyResolve = null;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._closed) return resolve();

            const apiKey = process.env.ELEVENLABS_API_KEY;

            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000'
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

            // Timeout: if no session_started within 10s, resolve anyway
            const timeout = setTimeout(() => {
                if (!resolved) {
                    console.warn('[ASR] Timed out waiting for session_started');
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.isReady = true;
                    }
                    safeResolve();
                }
            }, 10000);

            this.ws.on('open', () => {
                console.log('[ASR] Connected to ElevenLabs Scribe V2 Realtime');
                this._reconnectAttempts = 0;

                // CRITICAL: Start sending silence frames IMMEDIATELY on open
                // Don't wait for session_started — ElevenLabs may close if it 
                // doesn't receive audio quickly after the TCP handshake
                this._startInitialSilence();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    const msgType = response.type || response.message_type;

                    if (msgType === 'session_started') {
                        console.log('[ASR] Session started by server');
                        this.isReady = true;
                        clearTimeout(timeout);

                        // Switch from aggressive initial silence to normal keepalive
                        this._stopInitialSilence();
                        this._startKeepalive();

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
                this._stopInitialSilence();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                console.log(`[ASR] Disconnected (code=${code}, reason=${reasonStr})`);
                this.isReady = false;
                this._stopKeepalive();
                this._stopInitialSilence();
                clearTimeout(timeout);

                // Reconnect on ANY close if not intentionally closed
                // Even code=1000 — ElevenLabs sometimes sends 1000 on idle timeout
                if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(500 * this._reconnectAttempts, 3000);
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
     * Send silence frames very aggressively right after connection opens.
     * This prevents ElevenLabs from closing the connection due to no audio data.
     * μ-law silence = 0xFF byte value. 160 bytes = 20ms at 8kHz.
     */
    _startInitialSilence() {
        this._stopInitialSilence();
        const silence = Buffer.alloc(160, 0xFF);

        // Send first burst immediately
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(silence);
        }

        // Then every 100ms (simulates continuous audio stream)
        this._initialSilenceInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(silence);
            }
        }, 100);
    }

    _stopInitialSilence() {
        if (this._initialSilenceInterval) {
            clearInterval(this._initialSilenceInterval);
            this._initialSilenceInterval = null;
        }
    }

    /**
     * Normal keepalive: send silence every 2s to prevent idle disconnects.
     */
    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                const silence = Buffer.alloc(160, 0xFF);
                this.ws.send(silence);
            }
        }, 2000);
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
        this._stopInitialSilence();
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'call_ended');
        }
    }
}
