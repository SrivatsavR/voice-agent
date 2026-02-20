import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

/**
 * ElevenLabs TTS (Rachel / Flash v2.5 / Mulaw 8kHz)
 * 
 * Changes:
 * - Integrated structured Logger (replaces console.log)
 * - Speaking lifecycle hooks: onSpeakingStart / onSpeakingEnd
 *   Used by InterruptionManager to track when the agent is talking
 * - Proper connection lifecycle with explicit state tracking
 * - Better heartbeat that sends proper flush signals
 * - Reconnect support for dropped connections
 * - Proper close sequence (flush → EOS → close)
 */
const VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
const MODEL_ID = 'eleven_flash_v2_5';
const OUTPUT_FORMAT = 'ulaw_8000';

export class ElevenLabsTTS {
    /**
     * @param {WebSocket} twilioWs - The Twilio media-stream WebSocket
     * @param {string} streamSid - Twilio stream SID
     * @param {object} [options]
     * @param {Logger} [options.logger] - Call-scoped logger
     * @param {function} [options.onSpeakingStart] - Called when TTS audio starts
     * @param {function} [options.onSpeakingEnd] - Called when TTS generation is complete
     */
    constructor(twilioWs, streamSid, options = {}) {
        this.twilioWs = twilioWs;
        this.streamSid = streamSid;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._heartbeatInterval = null;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;

        // Hooks
        this._onSpeakingStart = options.onSpeakingStart || (() => { });
        this._onSpeakingEnd = options.onSpeakingEnd || (() => { });
        this._isSpeaking = false;

        // Logger
        this._log = (options.logger || new Logger('TTS')).withComponent('TTS');

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
                this._log.warn('Connection timed out after 10s');
                safeResolve();
            }, 10000);

            this.ws.on('open', () => {
                this.isReady = true;
                this._log.info('WebSocket connected');

                // Initialize with BOS (Beginning of Stream) message
                // Lower chunk_length_schedule for faster time-to-first-byte (min ~20, sweet spot 30)
                this.ws.send(JSON.stringify({
                    text: " ",
                    voice_settings: { stability: 0.5, similarity_boost: 0.8 },
                    generation_config: { chunk_length_schedule: [30] }
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
                            if (response.audio) {
                                this._markSpeakingStart();
                                this._sendToTwilio(response.audio);
                            }
                            if (response.error) this._log.error('Server error', { error: response.error });
                            if (response.isFinal) {
                                this._log.debug('Generation complete (isFinal)');
                                this._markSpeakingEnd();
                            }
                        } else {
                            // Raw binary audio frame
                            this._markSpeakingStart();
                            this._sendToTwilio(data.toString('base64'));
                        }
                    } else if (typeof data === 'string' && data.startsWith('{')) {
                        const response = JSON.parse(data);
                        if (response.audio) {
                            this._markSpeakingStart();
                            this._sendToTwilio(response.audio);
                        }
                        if (response.error) this._log.error('Server error', { error: response.error });
                        if (response.isFinal) {
                            this._log.debug('Generation complete (isFinal)');
                            this._markSpeakingEnd();
                        }
                    }
                } catch (err) {
                    // Ignore parse errors
                }
            });

            this.ws.on('error', (err) => {
                this._log.error('WebSocket error', err);
                this.isReady = false;
                this._stopHeartbeat();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                const reasonStr = reason ? reason.toString() : '';
                this._log.info('WebSocket closed', { code, reason: reasonStr });
                this.isReady = false;
                this._stopHeartbeat();
                this._markSpeakingEnd(); // Ensure speaking state is cleared
                clearTimeout(timeout);

                // Auto-reconnect on unexpected close
                if (!this._closed && code !== 1000 && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                    this._log.warn('Reconnecting', { delay_ms: delay, attempt: this._reconnectAttempts, max: this._maxReconnectAttempts });
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

    // ── Speaking state hooks ──────────────────────────────────────────────

    _markSpeakingStart() {
        if (!this._isSpeaking) {
            this._isSpeaking = true;
            try { this._onSpeakingStart(); } catch { }
        }
    }

    _markSpeakingEnd() {
        if (this._isSpeaking) {
            this._isSpeaking = false;
            try { this._onSpeakingEnd(); } catch { }
        }
    }

    // ── Heartbeat ─────────────────────────────────────────────────────────

    _startHeartbeat() {
        this._stopHeartbeat();
        // Send heartbeat every 15s to keep connection alive
        this._heartbeatInterval = setInterval(() => {
            if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
                try {
                    this.ws.send(JSON.stringify({ text: " " }));
                } catch (err) {
                    this._log.error('Heartbeat send error', err);
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
            this._log.debug('Sending text to TTS', { text_length: text.length, preview: text.substring(0, 80) });
            this.ws.send(JSON.stringify({
                text: text + " ",
                try_trigger_generation: true
            }));
        } else {
            this._log.warn('Cannot send text', { ready: this.isReady, wsState: this.ws?.readyState });
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
        this._markSpeakingEnd();
        this._log.info('Closing TTS connection');

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
