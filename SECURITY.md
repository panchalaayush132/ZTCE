# ZTCE Security Architecture

## Zero-Trust Design Philosophy

ZTCE is built on the principle that **no data should ever leave the local network**. Every component is designed to operate in a fully air-gapped environment without external dependencies.

---

## 1. Network Isolation

### Air-Gap Compliance
- **Zero outbound connections**: The platform makes no external API calls, no telemetry, no analytics
- **Local-only WebSockets**: All real-time communication routes through the local ASGI server
- **DNS independence**: All services communicate via IP addresses or Docker bridge networking
- **No CDN dependencies**: All static assets are bundled locally

### Network Topology
```
┌────────────────── Air-Gapped Network ──────────────────┐
│                                                         │
│   Operator A ──┐                                        │
│   Operator B ──┼── LAN Switch ── ZTCE Server            │
│   Operator C ──┘       │              │                 │
│                        │         ┌────┴────┐            │
│                    No Internet   │ Ollama  │            │
│                    Connection    │  (GPU)  │            │
│                                  └─────────┘            │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Data Encryption

### At-Rest Encryption
- **Algorithm**: Fernet symmetric encryption (AES-128-CBC + HMAC-SHA256)
- **Scope**: All chat messages and AI suggestions are encrypted before database storage
- **Key Derivation**: SHA-256 of Django SECRET_KEY or custom `ZTCE_ENCRYPTION_KEY`
- **Implementation**: `engine/security_utils.py` — `encrypt_text()` / `decrypt_text()`

### In-Transit Security
- WebSocket connections secured via local network TLS (configurable)
- Session tokens transmitted via custom `X-Session-Token` header
- No credentials stored in URLs or query parameters

---

## 3. Authentication & Authorization

### Session Token System
- 64-character cryptographically random tokens generated per session
- Token validation on every authenticated API request
- Tokens stored server-side, never exposed to unauthorized clients

### Rate Limiting
- Sliding-window rate limiter (40 requests/60 seconds default)
- Per-endpoint bucket isolation
- Protects against brute-force and DoS on the local network

---

## 4. Code Execution Sandboxing

### Subprocess Isolation
- Code executes in isolated Python subprocesses
- Configurable timeout enforcement (default: 10 seconds)
- stdout/stderr capture with size limits
- Process tree cleanup on timeout

### Resource Limits
- Memory limits via Docker container constraints
- CPU time limits via subprocess timeout
- Filesystem access restricted to designated workspace directories

---

## 5. AI Security (Zero-Trust)

### Local-Only AI
- All AI inference runs on local Ollama instance
- **No data transmitted to OpenAI, Google, Anthropic, or any cloud API**
- Model weights stored locally in Docker volume
- AI suggestions encrypted at rest before database storage

### Model Management
- Models pulled once and cached in persistent volume
- No automatic model updates (prevents supply-chain attacks)
- Configurable model selection per session

---

## 6. Supply Chain Security

### Dependency Pinning
- All Python dependencies pinned to exact versions in `requirements.txt`
- Node.js dependencies locked via `package-lock.json`
- Docker base images use specific version tags (not `latest`)

### Build Reproducibility
- Dockerfiles use `--no-cache-dir` for pip installs
- Multi-stage builds minimize attack surface
- No runtime package installation

---

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| Data exfiltration | Air-gapped network, zero external connections |
| Man-in-the-middle | Local network only, configurable TLS |
| Brute force auth | Rate limiting, 64-char random tokens |
| Code injection | Subprocess sandboxing, input validation |
| AI data leakage | Local Ollama only, no cloud APIs |
| Supply chain attack | Pinned dependencies, offline Docker builds |
| Privilege escalation | Django permission framework, session isolation |

---

## Compliance Alignment

ZTCE's security architecture aligns with requirements from:
- **NIST SP 800-171**: Controlled Unclassified Information protection
- **ITAR**: International Traffic in Arms Regulations (no data export)
- **SOC 2 Type II**: Data security and availability controls
- **FISMA**: Federal Information Security Management Act requirements
