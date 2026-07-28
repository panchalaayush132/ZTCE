# ZTCE — Zero-Trust Air-Gapped Collaborative Execution Engine

<p align="center">
  <strong>Enterprise-grade, air-gapped collaborative development platform with zero-trust AI assistance.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Django-5.2-092E20?logo=django&logoColor=white" />
  <img src="https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/WebSockets-ASGI-blue" />
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/AI-Ollama%20%7C%20Zero--Trust-ff6f00" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
</p>

---

## 🛡️ The Problem

High-security environments in **defense**, **finance**, and **enterprise** sectors physically disconnect their networks from the internet (**air-gapped infrastructure**) to prevent breaches. Every mainstream collaboration tool — VS Code Live Share, Google Docs, GitHub Copilot — **instantly breaks** because they depend on cloud servers.

**ZTCE** is the solution: a **self-contained, fully offline** collaborative development ecosystem. Multiple developers on a closed local network can write code, sync changes in real-time, execute programs, and leverage AI assistance — **without a single byte of data leaving the room.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        ZTCE Platform                            │
│                                                                 │
│  ┌──────────────┐   WebSocket (ASGI)   ┌──────────────────┐    │
│  │   Next.js    │◄───────────────────►│   Django Channels  │    │
│  │   React 19   │   Real-time Sync     │   Daphne Server   │    │
│  │   Monaco     │                      │   REST API        │    │
│  │   Excalidraw │                      │   Code Execution  │    │
│  └──────────────┘                      └────────┬─────────┘    │
│                                                  │              │
│  ┌──────────────┐                      ┌────────▼─────────┐    │
│  │   Electron   │                      │   Ollama (Local)  │    │
│  │  Desktop App │                      │   Zero-Trust AI   │    │
│  │  Native I/O  │                      │   Code Analysis   │    │
│  └──────────────┘                      └──────────────────┘    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              Docker Compose Orchestration                │    │
│  │         Single-command deployment for any host           │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
                    ALL TRAFFIC STAYS LOCAL
                    ZERO EXTERNAL DEPENDENCIES
```

---

## ✨ Key Features

### 🔄 Real-Time Sync Engine
- **Asynchronous ASGI WebSockets** via Django Channels for instant state propagation
- Multi-user collaborative code editing with conflict-free version tracking
- Live activity monitoring with traffic-light status indicators
- Real-time whiteboard collaboration via Excalidraw integration

### 🤖 Zero-Trust AI Engine
- **Local-only AI** powered by Ollama — no data ever leaves the network
- Code analysis, suggestions, and auto-completion
- AI-generated assessments and automated grading
- Fully configurable per-session AI toggle

### 💻 Professional IDE Interface
- **Monaco Editor** (the engine behind VS Code) with full syntax highlighting
- Multi-file workspace management with version history
- Integrated terminal with local Python execution
- PDF/document broadcasting and collaborative annotation

### 🐳 One-Command Deployment
- Complete Docker Compose orchestration
- Portable across any Linux, macOS, or Windows host
- Zero internet dependency after initial image pull
- Automatic service discovery on local network

### 🔒 Security Features
- **Fernet-encrypted** message and AI suggestion storage
- Session-token authentication with header validation
- Rate limiting and throttle protection
- Sandboxed code execution with timeout enforcement
- No telemetry, no analytics, no external API calls

---

## 🚀 Quick Start

### Docker (Recommended)
```bash
git clone https://github.com/panchalaayush132/ZTCE.git
cd ZTCE
docker-compose up --build
```
Access the platform at `http://localhost:3000`

### Manual Setup

#### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate    # Windows: venv\Scripts\activate
pip install -r requirements.txt
python manage.py migrate
python manage.py runserver 0.0.0.0:8000
```

#### Frontend
```bash
cd frontend
npm install
npm run dev:lan
```

#### Desktop App (Optional)
```bash
cd desktop-app
npm install
npm start
```

---

## 📊 Project Stats

| Metric | Value |
|--------|-------|
| Total Lines of Code | ~45,000+ |
| Backend (Python/Django) | ~15,000 lines |
| Frontend (TypeScript/React) | ~20,000 lines |
| Desktop App (Electron) | ~5,000 lines |
| Infrastructure (Docker/Config) | ~5,000 lines |
| WebSocket Event Types | 12+ |
| REST API Endpoints | 40+ |
| Database Models | 11 |

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Backend** | Django 5.2, DRF, Channels | REST API, WebSocket, Business Logic |
| **ASGI Server** | Daphne | Async WebSocket Protocol Handling |
| **Frontend** | Next.js 16, React 19 | Server-Side Rendering, Reactive UI |
| **Code Editor** | Monaco Editor | VS Code-grade editing experience |
| **Whiteboard** | Excalidraw | Collaborative diagramming |
| **Terminal** | xterm.js | Browser-based terminal emulation |
| **AI Engine** | Ollama (local) | Zero-trust code intelligence |
| **Desktop** | Electron | Native OS integration |
| **Database** | SQLite (portable) | Zero-config persistent storage |
| **Encryption** | Fernet (cryptography) | At-rest data encryption |
| **Containerization** | Docker Compose | Single-command deployment |

---

## 📁 Project Structure

```
ZTCE/
├── backend/                    # Django ASGI Backend
│   ├── config/                 # Project configuration
│   │   ├── settings.py         # Django settings (air-gap optimized)
│   │   ├── asgi.py             # ASGI + WebSocket routing
│   │   ├── urls.py             # Root URL configuration
│   │   └── views.py            # Health check & API discovery
│   ├── engine/                 # Core execution engine
│   │   ├── models.py           # 11 database models
│   │   ├── views.py            # 40+ API endpoints
│   │   ├── consumers.py        # WebSocket consumers
│   │   ├── serializers.py      # DRF serializers
│   │   ├── security_utils.py   # Encryption & rate limiting
│   │   └── routing.py          # WebSocket URL routing
│   ├── manage.py
│   └── requirements.txt
├── frontend/                   # Next.js 16 Frontend
│   ├── src/
│   │   ├── app/                # App router pages
│   │   ├── components/         # React components
│   │   └── lib/                # API utilities
│   └── package.json
├── desktop-app/                # Electron Desktop Wrapper
│   ├── main.js                 # Main process
│   ├── preload.js              # Context bridge
│   └── package.json
├── docker-compose.yml          # One-command deployment
├── Dockerfile.backend          # Backend container
├── Dockerfile.frontend         # Frontend container
├── SECURITY.md                 # Security architecture docs
├── ARCHITECTURE.md             # Technical deep-dive
└── LICENSE
```

---

## 🔐 Security Architecture

ZTCE implements a **defense-in-depth** security model:

1. **Network Isolation**: Designed for air-gapped networks with zero external dependencies
2. **Data Encryption**: All sensitive data encrypted at rest using Fernet symmetric encryption
3. **Session Authentication**: Token-based session validation via custom header middleware
4. **Rate Limiting**: Per-endpoint throttling to prevent abuse
5. **Sandboxed Execution**: Code runs in isolated subprocesses with resource limits
6. **Zero Telemetry**: No analytics, no tracking, no external API calls whatsoever

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <strong>Built for environments where security isn't optional — it's mandatory.</strong>
</p>
