import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

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
    /**
     * @param {function} onTranscript - Callback for committed transcripts
     * @param {object} [options]
     * @param {Logger} [options.logger] - Call-scoped logger
     */
    constructor(onTranscript, options = {}) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._keepaliveInterval = null;

        this._log = (options.logger || new Logger('ASR')).withComponent('ASR');

        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            if (this._closed) return resolve();

            const apiKey = process.env.ELEVENLABS_API_KEY;

            // CRITICAL configuration via query parameters:
            // 1. audio_format=ulaw_8000: Twilio sends μ-law 8kHz (default pcm_16000 = garbled)
            // 2. commit_strategy=vad: Auto-commit transcript when silence detected
            //    (default is 'manual' which only sends partial_transcript, never committed)
            // 3. vad_silence_threshold_secs=1.0: Commit after 1s silence (responsive for voice agent)
            // 4. language_code=en: Optimize for English
            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000',
                language_code: 'en',
                commit_strategy: 'vad',
                vad_silence_threshold_secs: '1.0',
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            this._log.info('Connecting to ElevenLabs ASR', { attempt: this._reconnectAttempts + 1 });

            this.ws = new WebSocket(url, {
                headers: { 'xi-api-key': apiKey }
            });

            let resolved = false;
            const safeResolve = () => {
                if (!resolved) { resolved = true; resolve(); }
            };

            const timeout = setTimeout(() => {
                if (!resolved) {
                    this._log.warn('Timed out waiting for session_started (10s)');
                    if (this.ws?.readyState === WebSocket.OPEN) {
                        this.isReady = true;
                    }
                    safeResolve();
                }
            }, 10000);

            this.ws.on('open', () => {
                this._log.info('WebSocket open, waiting for session_started');
                this._reconnectAttempts = 0;
            });

            this.ws.on('message', (data) => {
                try {
                    const text = Buffer.isBuffer(data) ? data.toString() : data;
                    const response = JSON.parse(text);
                    const msgType = response.type || response.message_type;

                    if (msgType === 'session_started') {
                        this._log.info('Session started by server');
                        this.isReady = true;
                        clearTimeout(timeout);
                        this._startKeepalive();
                        safeResolve();
                    } else if (msgType === 'transcript' || msgType === 'committed_transcript' || msgType === 'final_transcript') {
                        const transcript = (response.transcript || response.text || '').trim();
                        if (transcript && this.onTranscript) {
                            this._log.info(`Committed transcript: ${transcript}`, { type: msgType });
                            this.onTranscript(transcript);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const transcript = (response.transcript || response.text || '').trim();
                        if (transcript) this._log.debug(`Partial: ${transcript}`);
                    } else if (msgType === 'error' || response.error) {
                        this._log.error('Server error', { error: response.error || response.message || response });
                    } else {
                        this._log.debug(`Received msg type: ${msgType}`);
                    }
                } catch (err) {
                    // Not JSON, ignore
                }
            });

            this.ws.on('error', (err) => {
                this._log.error('WebSocket error', err);
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                this._log.info('Disconnected', { code, reason: reasonStr });
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);

                if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    this._log.warn('Reconnecting', { delay_ms: delay, attempt: this._reconnectAttempts, max: this._maxReconnectAttempts });
                    setTimeout(() => {
                        if (!this._closed) {
                            this._connectPromise = this._connect();
                        }
                    }, delay);
                } else if (!this._closed) {
                    this._log.error('Max reconnect attempts exhausted', { max: this._maxReconnectAttempts });
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
        this._log.info('Closing ASR connection');
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.close(1000, 'call_ended');
        }
    }
}
