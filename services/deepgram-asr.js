import { WebSocket } from 'ws';
import { Logger } from '../utils/logger.js';

/**
 * FIXED: DeepgramASR with TypeError fix + faster connection + buffer management
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
        this._connectPromise = null;  // FIXED: Proper promise tracking

        this._log = (options.logger || new Logger('ASR')).withComponent('ASR');
        this._connect();  // Start immediately
    }

    async _connect() {
        if (this._closed) return Promise.resolve();

        const apiKey = process.env.DEEPGRAM_API_KEY;
        if (!apiKey) {
            this._log.error('DEEPGRAM_API_KEY not set!');
            return Promise.resolve();
        }

        const params = new URLSearchParams({
            model: process.env.DEEPGRAM_MODEL || 'nova-2',
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
            url: url.substring(0, 80) + '...' 
        });

        // FIXED: Safe WebSocket options
        this.ws = new WebSocket(url, [], {
            timeout: 8000,  // Faster timeout
            headers: {
                'Authorization': `Token ${apiKey}`,
                'User-Agent': 'DeepgramNodeClient/1.0'
            },
            perMessageDeflate: false,
            rejectUnauthorized: process.env.NODE_ENV !== 'production',
            handshakeTimeout: 5000  // Faster handshake
        });

        // FIXED: Return proper promise
        return new Promise((resolve) => {
            let resolved = false;
            const safeResolve = () => { 
                if (!resolved) { 
                    resolved = true; 
                    resolve(); 
                } 
            };

            const timeout = setTimeout(() => {
                this._log.warn('Deepgram connection timeout (8s)');
                this.isReady = false;
                safeResolve();
            }, 8000);

            this.ws.on('open', () => {
                this._log.info('✅ Deepgram WebSocket connected');
                this.isReady = true;
                this._reconnectAttempts = 0;
                this._startKeepalive();
                clearTimeout(timeout);
                safeResolve();
            });

            // FIXED: Safe headers logging (TypeError fix)
            this.ws.on('unexpected-response', (request, response) => {
                const headers = {};
                if (response.headers) {
                    try {
                        // Safe iteration - handle Node.js response.headers properly
                        Object.keys(response.headers).forEach(key => {
                            headers[key] = response.headers[key];
                        });
                    } catch (e) {
                        headers['headers_parse_error'] = 'failed';
                    }
                }
                
                this._log.error('❌ Deepgram handshake failed', {
                    status: response.statusCode,
                    statusText: response.statusText || 'unknown',
                    headers: headers
                });
                this.isReady = false;
                safeResolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const text = Buffer.isBuffer(data) ? data.toString() : data.toString();
                    const response = JSON.parse(text);
                    const msgType = response.type || 'unknown';

                    switch (msgType) {
                        case 'Results':
                            this._handleTranscriptResult(response);
                            break;
                        case 'UtteranceEnd':
                            if (this._utteranceBuffer.trim() && this.onTranscript) {
                                this.onTranscript(this._utteranceBuffer.trim());
                                this._utteranceBuffer = '';
                            }
                            break;
                        case 'SpeechStarted':
                        case 'SpeechEnded':
                            break; // VAD events
                        case 'Metadata':
                            this._log.debug('Metadata', { 
                                request_id: response.request_id,
                                model: response.model_info?.name 
                            });
                            break;
                        case 'Error':
                            this._log.error('Deepgram API error', response);
                            break;
                        default:
                            this._log.trace(`Deepgram: ${msgType}`);
                    }
                } catch (err) {
                    // Binary audio or parse error - ignore
                }
            });

            this.ws.on('error', (err) => {
                this._log.error('Deepgram WebSocket error', err.message);
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);
                safeResolve();
            });

            this.ws.on('close', (code, reason) => {
                this._log.info('Deepgram disconnected', { code, reason: reason?.toString() || 'none' });
                this.isReady = false;
                this._stopKeepalive();
                clearTimeout(timeout);

                if (!this._closed && this._reconnectAttempts < this._maxReconnectAttempts) {
                    this._reconnectAttempts++;
                    const delay = 1000 * this._reconnectAttempts;
                    setTimeout(() => this._connect(), delay);
                }
                safeResolve();
            });
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
            // Partial - ignore for now
            return;
        }

        if (speechFinal) {
            // Full utterance complete
            const full = this._utteranceBuffer 
                ? `${this._utteranceBuffer} ${transcript}`.trim() 
                : transcript;
            this._utteranceBuffer = '';
            
            if (full && this.onTranscript) {
                this.onTranscript(full);
            }
        } else {
            // Accumulate ongoing speech
            this._utteranceBuffer = this._utteranceBu
