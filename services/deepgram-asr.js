import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

/**
 * Manages the WebSocket connection to Deepgram Live Transcription API.
 * Drop-in replacement for ElevenLabsASR with 400 error fixes.
 *
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 */
export class DeepgramASR {
    constructor(onTranscript, options = {}) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._closed = false;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = 3;
        this._keepaliveInterval = null;
        this._utteranceBuffer = '';

        this._log = (options.logger || new Logger('ASR')).withComponent('ASR');
        this._connectPromise = this._connect();
    }

    async _connect() {
        if (this._closed) return;

        const apiKey = process.env.DEEPGRAM_API_KEY;
        if (!apiKey) {
            this._log.error('DEEPGRAM_API_KEY not set!');
            return;
        }

        const params = new URLSearchParams({
            model: process.env.DEEPGRAM_MODEL || 'nova-2', // Fallback from nova-3
            encoding: 'mulaw',
            sample_rate: '8000',
            channels: '1',
            punctuate: 'true',
            interim_results: 'true',
            endpointing: '200',
            utterance_end_ms: '500',
            vad_events: 'true',
            language: 'en',
        });

        const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
        this._log.info('Connecting to Deepgram', { 
            attempt: this._reconnectAttempts + 1, 
            url: url.substring(0, 100) + '...' 
        });

        // FIXED: Proper WebSocket options for Deepgram handshake
        this.ws = new WebSocket(url, [], {
            timeout: 10000,
            headers: {
                'Authorization': `Token ${apiKey}`, // Exact casing required
                'User-Agent': 'DeepgramNodeClient/1.0'
            },
            perMessageDeflate: false,        // Disables compression (400 fix)
            rejectUnauthorized: false,       // TLS handshake fix for self-signed/staging
            handshakeTimeout: 10000,
            protocolVersion: 13             // Explicit WebSocket protocol
        });

        let resolved = false;
        const safeResolve = () => { if (!resolved) { resolved = true; } };

        // Connection timeout
        const timeout = setTimeout(() => {
            if (!resolved) {
                this._log.warn('Deepgram connection timeout (10s)');
                safeResolve();
            }
        }, 10000);

        this.ws.on('open', () => {
            this._log.info('Deepgram WebSocket connected');
            this.isReady = true;
            this._reconnectAttempts = 0;
            this._startKeepalive();
            clearTimeout(timeout);
            safeResolve();
        });

        // FIXED: Capture handshake failures
        this.ws.on('unexpected-response', (request, response) => {
            this._log.error('Deepgram handshake failed', {
                status: response.statusCode,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers)
            });
            this.isReady = false;
            safeResolve();
        });

        this.ws.on('message', (data) => {
            try {
                const text = Buffer.isBuffer(data) ? data.toString() : data;
                const response = JSON.parse(text);
                const msgType = response.type;

                switch (msgType) {
                    case 'Results':
                        this._handleTranscriptResult(response);
                        break;
                    case 'UtteranceEnd':
                        if (this._utteranceBuffer.trim() && this.onTranscript) {
                            this._log.debug(`UtteranceEnd: committing "${this._utteranceBuffer.trim()}"`);
                            this.onTranscript(this._utteranceBuffer.trim());
                            this._utteranceBuffer = '';
                        }
                        break;
                    case 'SpeechStarted':
                        this._log.debug('SpeechStarted (VAD)');
                        break;
                    case 'Metadata':
                        this._log.info('Deepgram metadata', {
                            request_id: response.request_id,
                            model: response.model_info?.name
                        });
                        break;
                    case 'Error':
                        this._log.error('Deepgram API error', { error: response });
                        break;
                    default:
                        this._log.debug(`Deepgram: ${msgType}`);
                }
            } catch (err) {
                // Binary audio or parse error, ignore
            }
        });

        this.ws.on('error', (err) => {
            this._log.error('Deepgram WebSocket error', err);
            this.isReady = false;
            this._stopKeepalive();
            clearTimeout(timeout);
            safeResolve();
        });

        this.ws.on('close', (code, reason) => {
            const reasonStr = reason?.toString() || 'unknown';
            this._log.info('Deepgram disconnected', { code, reason: reasonStr });
            this.isReady = false;
            this._stopKeepalive();
            clearTimeout(timeout);

            if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                this._reconnectAttempts++;
                const delay = Math.min(1000 * this._reconnectAttempts, 5000);
                this._log.warn('Reconnecting to Deepgram', { 
                    delay_ms: delay, 
                    attempt: this._reconnectAttempts 
                });
                setTimeout(() => {
                    if (!this._closed) {
                        this._connect();
                    }
                }, delay);
            } else if (!this._closed) {
                this._log.error('Max Deepgram reconnect attempts exhausted');
            }
            safeResolve();
        });
    }

    _handleTranscriptResult(response) {
        const channel = response.channel;
        if (!channel?.alternatives?.length) return;

        const alt = channel.alternatives[0];
        const transcript = (alt.transcript || '').trim();
        if (!transcript) return;

        const isFinal = !!response.is_final;
        const speechFinal = !!response.speech_final;

        if (!isFinal) {
            this._log.debug(`Partial: ${transcript}`);
            return;
        }

        if (speechFinal) {
            // Commit utterance
            const fullTranscript = this._utteranceBuffer 
                ? `${this._utteranceBuffer} ${transcript}`.trim() 
                : transcript;
            this._utteranceBuffer = '';
            
            if (fullTranscript && this.onTranscript) {
                this._log.info(`Transcript: ${fullTranscript}`);
                this.onTranscript(fullTranscript);
            }
        } else {
            // Buffer for ongoing speech
            this._utteranceBuffer = this._utteranceBuffer 
                ? `${this._utteranceBuffer} ${transcript}`.trim() 
                : transcript;
            this._log.debug(`Buffering: ${transcript} (buffer=${this._utteranceBuffer.length} chars)`);
        }
    }

    _startKeepalive() {
        this._stopKeepalive();
        this._keepaliveInterval = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
                this._log.debug('Sent KeepAlive');
            }
        }, 5000);
    }

    _stopKeepalive() {
        if (this._keepaliveInterval) {
            clearInterval(this._keepaliveInterval);
            this._keepaliveInterval = null;
        }
    }

    sendAudio(base64Audio) {
        if (this.ws?.readyState !== WebSocket.OPEN || !this.isReady) {
            this._log.debug('Cannot send audio: not ready');
            return;
        }

        if (!base64Audio) return;

        try {
            const audioBuffer = Buffer.from(base64Audio, 'base64');
            this.ws.send(audioBuffer, (err) => {
                if (err) this._log.error('Audio send failed', err);
            });
        } catch (err) {
            this._log.error('Audio decode/send error', err);
        }
    }

    async waitReady() {
        await this._connectPromise;
        return this.isReady;
    }

    close() {
        this._closed = true;
        this.isReady = false;
        this._stopKeepalive();

        if (this._utteranceBuffer.trim() && this.onTranscript) {
            this.onTranscript(this._utteranceBuffer.trim());
            this._utteranceBuffer = '';
        }

        if (this.ws?.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({ type: 'CloseStream' }));
            } catch {}
            
            setTimeout(() => {
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.close(1000, 'call_ended');
                }
            }, 1000);
        }
    }
}
