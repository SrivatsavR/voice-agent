import { ElevenLabsTTS } from './services/elevenlabs-tts.js';
import EventEmitter from 'events';

// Mock Twistio WS
class MockWs extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1; // OPEN
        this.sentMessages = [];
    }
    send(data) {
        this.sentMessages.push(JSON.parse(data));
        if (this.sentMessages[this.sentMessages.length - 1].event === 'media') {
            // console.log('Mock Twilio: Received audio chunk');
        }
    }
}

// Mock ElevenLabs WS
class MockElevenLabsWs extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1; // OPEN
    }
    send(data) {
        // console.log('Mock ElevenLabs: Sent text:', data);
    }
    close() {
        this.emit('close', 1000, 'normal');
    }
}

async function runTest() {
    const mockTwilio = new MockWs();
    const tts = new ElevenLabsTTS(mockTwilio, 'sid-123', {
        onSpeakingStart: () => console.log('[Event] Speaking Started'),
        onSpeakingEnd: () => console.log('[Event] Speaking Ended')
    });

    // Mock the connection process
    tts.ws = new MockElevenLabsWs();
    tts.isReady = true;

    console.log('--- Initial State ---');
    console.log('isSpeaking:', tts.isSpeaking);
    console.log('hasPendingAudio:', tts.hasPendingAudio());

    console.log('\n--- Sending Text ---');
    await tts.sendText('Hello world');
    console.log('isSpeaking:', tts.isSpeaking);
    console.log('hasPendingAudio:', tts.hasPendingAudio());

    console.log('\n--- Receiving Audio Chunks (Base64) ---');
    // Buffer logic in TTS: totalBytes / 8000 * 1000
    // 8000 bytes = 1s
    const audioData = Buffer.alloc(8000).toString('base64');
    // Manually trigger the message handler logic
    tts._markSpeakingStart();
    tts._sendToTwilio(audioData);

    console.log('isSpeaking:', tts.isSpeaking);
    console.log('hasPendingAudio:', tts.hasPendingAudio());

    // Wait for speaking to end (it schedules end at duration + 500ms)
    // 1s audio + 500ms = 1.5s
    console.log('\nWaiting for audio to drain...');
    await new Promise(r => setTimeout(r, 2000));

    console.log('isSpeaking:', tts.isSpeaking);
    console.log('hasPendingAudio:', tts.hasPendingAudio());

    tts.close();
}

process.env.ELEVENLABS_API_KEY = 'mock-key';
runTest().catch(console.error);
