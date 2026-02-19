import { WebSocket } from 'ws';

/**
 * Manages the WebSocket connection to ElevenLabs ASR (Scribe v2 Realtime).
 * Feed audio chunks via sendAudio(). Transcripts are delivered via onTranscript callback.
 */
export class ElevenLabsASR {
    constructor(onTranscript) {
        this.onTranscript = onTranscript;
        this.ws = null;
        this.isReady = false;
        this._heartbeatInterval = null;
        this._connectPromise = this._connect();
    }

    _connect() {
        return new Promise((resolve) => {
            const apiKey = process.env.ELEVENLABS_API_KEY;

            // Adding inactivity_timeout and ensuring the model is scribe_v2_realtime
            const params = new URLSearchParams({
                model_id: 'scribe_v2_realtime',
                audio_format: 'ulaw_8000',
                inactivity_timeout: '180'
            });
            const url = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;

            this.ws = new WebSocket(url, {
                headers: {
                    'xi-api-key': apiKey
                }
            });

            this.ws.on('open', () => {
                console.log('[ASR] Connected to ElevenLabs Scribe V2 Realtime');
                this.isReady = true;
                this._startHeartbeat();
                resolve();
            });

            this.ws.on('message', (data) => {
                try {
                    const response = JSON.parse(data);
                    const msgType = response.message_type || response.type;

                    if (msgType === 'transcript' || msgType === 'final_transcript' || msgType === 'committed_transcript_with_timestamps') {
                        const text = (response.text || response.data?.text || '').trim();
                        if (text && this.onTranscript) {
                            console.log(`[ASR] FINAL: ${text}`);
                            this.onTranscript(text);
                        }
                    } else if (msgType === 'partial_transcript') {
                        const text = (response.text || '').trim();
                        if (text) console.log(`[ASR] partial: ${text}`);
                    } else if (msgType === 'input_error' || msgType === 'error') {
                        console.error('[ASR] Server error:', response.error || response.message || JSON.stringify(response));
                    } else if (msgType === 'session_begin') {
                        console.log('[ASR] Session started by server');
                    }
                } catch (err) { }
            });

            this.ws.on('error', (err) => {
                console.error('[ASR] WebSocket Error:', err.message);
                this.isReady = false;
                this._stopHeartbeat();
                resolve();
            });

            this.ws.on('close', (code, reason) => {
                console.log(`[ASR] Disconnected (code=${code}, reason=${reason})`);
                this.isReady = false;
                this._stopHeartbeat();
                resolve();
            });
        });
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this._heartbeatInterval = setInterval(() => {
            if (this.isReady && this.ws?.readyState === WebSocket.OPEN) {
                // Keep-alive heartbeat for ASR
                // Using an empty ping-like message if supported, 
                // but since ASR is input-driven, we just ensure the socket doesn't idle.
                this.ws.ping();
            }
        }, 15000);
    }

    _stopHeartbeat() {
        if (this._heartbeatInterval) {
            clearInterval(this._heartbeatInterval);
            this._heartbeatInterval = null;
        }
    }

    sendAudio(base64Audio) {
        if (this.ws?.readyState === WebSocket.OPEN && this.isReady) {
            this.ws.send(JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64Audio
            }));
        }
    }

    async waitReady() {
        await this._connectPromise;
    }

    close() {
        this.isReady = false;
        this._stopHeartbeat();
        if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ message_type: 'eos' })); } catch { }
            this.ws.close();
        }
    }
}
