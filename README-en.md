# SonicScribe — Real-time Speech-to-Text System

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.8%2B-blue)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/node.js-18%2B-green)](https://nodejs.org/)

> 🔊 Real-time speech recognition system based on [GLM-ASR-Nano-2512](https://huggingface.co/zai-org/GLM-ASR-Nano-2512), supporting both real-time conversation and file upload modes.

---

## 🧩 Project Overview

SonicScribe is a Web-native real-time speech-to-text system built on the **GLM-ASR-Nano-2512** model, using a frontend-backend separation architecture. It provides low-latency, high-accuracy speech recognition for various applications including meeting transcription, lecture summarization, interview notes, and everyday conversation.

The system supports two core modes:
- **Real-time conversation**: Microphone captures audio in real time, with text output as you speak, including voice detection and status indicators.
- **File analysis**: Upload audio files (supporting WAV, MP3, FLAC, etc.) for automatic transcription with streaming results.

## 🌐 Language Versions

- [Chinese version README](README.md)
- [English version README](README-en.md)

---

## 🚀 Quick Start

### Prerequisites
- Python 3.8+
- Node.js 18+
- `git`, `pip`, `npm`

### Installation and Configuration

```bash
# 1. Clone the project
git clone https://github.com/gengyuchao/SonicScribe.git
cd SonicScribe

# 2. Install backend dependencies
cd backend
python -m venv venv
source venv/bin/activate   # Linux/Mac
# or: venv\Scripts\activate  # Windows
pip install -r requirements.txt
cp .env_template .env

# 3. Install frontend dependencies
cd ../frontend
npm install
cp .env_template .env

# 4. Download speech recognition model
# Visit: https://huggingface.co/zai-org/GLM-ASR-Nano-2512
# Download and place in: backend/models/GLM-ASR-Nano-2512
```

### Start the Services

```bash
# Start backend service
cd backend
python main.py

# Start frontend development server
cd ../frontend
npm run dev -- --port 8080
```

> 🌐 Open your browser at `http://localhost:8080` to start using the application.

![screenshot](./resources/screenshot.jpg)
---

## 📌 Usage Instructions

### Real-time Conversation
1. Go to the **"Real-time Conversation"** tab.
2. Click **"Start Recording"** and grant microphone permission.
3. Start speaking—the system will display real-time transcription.
4. Click **"Stop"** to end recording and view the complete text.

### File Transcription
1. Go to the **"File Analysis"** tab.
2. Click **"Select File"** to upload audio (supports MP3, WAV, FLAC, M4A, OGG, WebM).
3. Click **"Start Transcription"**—the system processes the file and shows progress in real time.
4. After completion, view the full text, timestamps, and statistics.

---

## ⚙️ System Architecture

### Real-time Processing Flow
1. Audio data is chunked in **64ms** segments.
2. Transmitted in real time via **WebSocket** to the backend.
3. Backend performs **Voice Activity Detection (VAD)** to filter silent segments.
4. Voice segments are capped at **20 seconds** (configurable) and automatically split if longer.
5. Results are returned in two phases:
   - **Intermediate results**: Generated every second for real-time preview.
   - **Final results**: Confirmed and output when the segment ends.

### Audio Preprocessing
- Supported formats: WAV, MP3, FLAC, M4A, OGG, WebM.
- Automatically converted to **16kHz mono PCM** format.
- Input normalized to floating-point `[1, N]` format to ensure consistent model input.

### Model and Acceleration
- Uses **GLM-ASR-Nano-2512** model, supporting Mandarin and English recognition.
- GPU (CUDA) is recommended for acceleration, significantly improving processing speed.
- Enable with `DEVICE=cuda` in environment variables.

---

## 📋 Configuration

Copy `.env_template` to `.env` in both backend and frontend directories and modify as needed:

| Variable | Default Value | Description |
|--------|---------------|------------|
| `HOST` | `0.0.0.0` | Service binding address |
| `PORT` | `8000` | Service port |
| `DEVICE` | `cuda` | Use `cuda` for GPU acceleration (recommended) |
| `VAD_SPEECH_THRESHOLD` | `0.6` | VAD speech detection threshold (lower = more sensitive) |
| `MAX_SEGMENT_DURATION` | `20.0` | Maximum duration of a single voice segment (seconds) |

> 💡 We recommend using GPU (at least 6GB VRAM) for optimal performance.

> 💡 Note: Backend and frontend use different ports—configure according to your application needs.

---

## 📦 Project Limitations

- Supported audio formats: WAV, MP3, FLAC, M4A, OGG, WebM.
- Browser support: Modern browsers with Web Audio API and WebSocket support (Chrome, Firefox, Edge).

## 🔐 SSL Certificate Generation

The project includes a convenient script to generate self-signed SSL certificates:

1. Navigate to the certificates directory:
   ```bash
   cd certs
   ```

2. Make the script executable:
   ```bash
   chmod +x generate_cert.sh
   ```

3. Run the script:
   ```bash
   ./generate_cert.sh
   ```

4. Generated files:
   - `cert.pem` - certificate file
   - `key.pem` - private key file

5. Usage notes:
   - Self-signed certificates require manual trust in browsers
   - Use Let's Encrypt or commercial certificates for production environments

---

## 📚 Contribution Guidelines

We welcome community contributions! Please follow these steps:
1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/new-feature`.
3. Commit your changes: `git commit -m 'Add new feature'`.
4. Push to the remote: `git push origin feature/new-feature`.
5. Submit a Pull Request.

---

## 📜 License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [GLM-ASR-Nano-2512](https://huggingface.co/zai-org/GLM-ASR-Nano-2512) — Efficient Chinese speech recognition model.
- [Silero VAD](https://github.com/snakers4/silero-vad) — Reliable voice activity detection technology.

---

> ✅ Designed for developers, optimized for real-time speech processing.  
> 🚀 Start your speech-to-text journey — click to begin!