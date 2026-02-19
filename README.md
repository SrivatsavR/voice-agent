# Voice AI Platform (Meesho Demo)

This project implements a low-latency voice AI platform using:
- **Twilio Media Streams** for telephony audio.
- **ElevenLabs ASR (Scribe/Realtime)** for speech-to-text.
- **OpenAI GPT-4o-mini** for intelligence.
- **ElevenLabs Flash v2.5** for text-to-speech.

## Prerequisites

1.  **Node.js**: Install from [nodejs.org](https://nodejs.org/).
2.  **Ngrok**: Install from [ngrok.com](https://ngrok.com/) to expose your local server.
3.  **Twilio Account**: Phone number and credentials.
4.  **ElevenLabs Account**: API Key.
5.  **OpenAI Account**: API Key.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Environment Variables**:
    Create a `.env` file in the root directory with the following keys:
    ```env
    OPENAI_API_KEY=your_openai_key
    ELEVENLABS_API_KEY=your_elevenlabs_key
    TWILIO_ACCOUNT_SID=your_twilio_sid
    TWILIO_AUTH_TOKEN=your_twilio_token
    PORT=3000
    ```

## Running the Server

1.  **Start the server**:
    ```bash
    npm start
    ```
    Or:
    ```bash
    node server.js
    ```

2.  **Expose via Ngrok**:
    In a separate terminal:
    ```bash
    ngrok http 3000
    ```
    Copy the forwarding URL (e.g., `https://abc1234.ngrok.io`).

## Twilio Configuration

1.  Go to your Twilio Console > Phone Numbers > Manage > Active Numbers.
2.  Click on your number.
3.  Under **Voice & Fax** > **A Call Comes In**:
    -   Select **Webhook**.
    -   Enter your Ngrok URL followed by `/incoming` (e.g., `https://abc1234.ngrok.io/incoming`).
    -   Ensure typical HTTP method is set to **POST**.
4.  Save.

## Usage

Call your Twilio phone number. The system should:
1.  Answer and connect to the media stream.
2.  Transcribe your speech using ElevenLabs ASR.
3.  Generate a response using OpenAI GPT-4o-mini.
4.  Stream audio back using ElevenLabs TTS.

## Troubleshooting

-   **Latency**: Ensure you utilize the closest regions for Twilio and 11Labs if configurable.
-   **Audio Format**: Twilio uses Mulaw 8kHz. The code assumes ElevenLabs handles this or conversion is done.
-   **Node.js Missing**: If `node` commands fail, ensure Node.js is installed and in your PATH.
