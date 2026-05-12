# Realtime Voice Translation Engine (Plivo + OpenAI)

Stateless backend service that dials two PSTN endpoints through **Plivo**, joins them inside a muted **audio conference**, and attaches **bidirectional µ-law streams** to this engine. Telephone audio is streamed to **[OpenAI Realtime Translation](https://developers.openai.com/api/docs/guides/realtime-translation)** (`/v1/realtime/translations`) for simultaneous interpretation.

No database, no auth, no browser UI, and **no persisted transcripts or recordings**.

## Architecture overview

```
CRM (POST /call)
    → CallOrchestrator (in-memory TranslationSession per call)
       → Plivo outbound: agent ring first → answer_url joins conference(tr-${uuid})
       → Start bidirectional µ-law websocket stream (/ws/plivo?session=&leg=)
       → Plivo outbound: customer second leg (same patterns)
TranslationSession wires:
       customer RTP → translator A (output = agent_listen_lang) → playAudio → agent WS
       agent RTP → translator B (output = customer_listen_lang) → playAudio → customer WS
```

Operational notes:

- **Conference mute (`muted=true`)**: participants are suppressed on the acoustic bridge mix so callers should not hear one another “raw”, while Plivo streams can still expose mic audio for interpretation. Confirm behaviour with **your carrier + Plivo account** — if RTP becomes silent while muted, set `muted="false"` in `src/plivo/xml.js` and accept the privacy implication (agents may overhear originals).
- **Low latency knobs**: µ-law **8 kHz**, stream chunk pacing from Plivo, simple hold-based **8→24 kHz** upsampling for OpenAI, **µ-law RMS VAD + `clearAudio`** for barge-in.
- **Stateless caveat**: Sessions live in RAM (`SessionRegistry`). One replica per SIP domain is typical; clustering needs a shared signalling layer beyond this scaffold.

---

## Prerequisites

| Item | Detail |
| --- | --- |
| Node.js | **20.x or 22.x LTS** |
| Accounts | Active Plivo + OpenAI billing |
| Telephone | Verified Plivo DID (`PLIVO_PHONE_NUMBER`) |
| Public URLs | `BASE_URL` (HTTPS REST webhooks Plivo reaches) · `WS_BASE_URL` (**WSS** origin for inbound media upgrades) |

`WS_BASE_URL` must be **origin only** (`wss://your-host`). The service appends **`/ws/plivo?session=…&leg=…`** verbatim so Plivo signatures stay stable.

---

## Environment variables

See `.env.example`. Required for production-grade runs:

| Name | Meaning |
| --- | --- |
| `PORT` | HTTP listener (default `3000`) |
| `BASE_URL` | Public base for `/plivo/webhook/*` URLs |
| `WS_BASE_URL` | Public websocket origin for streamed calls |
| `PLIVO_AUTH_ID` · `PLIVO_AUTH_TOKEN` | REST credential pair |
| `PLIVO_PHONE_NUMBER` | Caller-ID / source number |
| `OPENAI_API_KEY` | Bearer token |
| `OPENAI_REALTIME_MODEL` | Default `gpt-realtime-translate` |

Optional tuning:

| Name | Meaning |
| --- | --- |
| `PLIVO_VALIDATE_SIGNATURES` | `true` verifies `X-Plivo-Signature-V2*` REST callbacks (**default `false`** for faster dev) |
| `CUSTOMER_DIAL_DELAY_MS` | Pause before second outbound leg (default `400`) |
| `SESSION_IDLE_TTL_MS` | In-memory eviction guard |
| `CALL_SETUP_TIMEOUT_MS` | Drops sessions if customer never answers |
| `OPENAI_SAFETY_IDENTIFIER` | Optional hashed id header for OpenAI safety |

---

### OpenAI: call connects but silence / `gpt-realtime-translate` access errors

The dedicated **[GPT Realtime Translate](https://developers.openai.com/api/docs/models/gpt-realtime-translate)** SKU (`/v1/realtime/translations`) is **not usable on OPENAI FREE tiers** (“Not supported” in OpenAI’s own rate-limit docs).

Logs like **`model … does not exist or you do not have access`** mean either wrong model slug **or** the key lacks entitlement.

| Path | What to do |
| --- | --- |
| Intended production latency | Upgrade billing / usage tier, then `OPENAI_REALTIME_PIPELINE=translation` plus `OPENAI_TRANSLATION_MODEL=gpt-realtime-translate`. |
| Dev / capped keys | `OPENAI_REALTIME_PIPELINE=voice` (see `.env.example`) uses **[standard Realtime WS](https://developers.openai.com/api/docs/guides/realtime-websocket)** + interpreter prompting. Latency higher (VAD turn-taking) but usually works without the translation product. Tune `OPENAI_VOICE_VAD_KIND` (`server_vad` vs `semantic_vad`). |

Restart Node after `.env` edits.

---

## Local development

1. `cp .env.example .env`
2. Install deps: `npm install`
3. Expose BOTH HTTPS + WSS tunnels (recommended: **[ngrok](https://ngrok.com/)**) pointing to `${PORT}`
4. Populate `.env`:
   ```
   BASE_URL=https://YOUR_NGROK_SUBDOMAIN.ngrok-free.app
   WS_BASE_URL=wss://YOUR_NGROK_SUBDOMAIN.ngrok-free.app
   ```
5. Configure Plivo number / application if needed — outbound calls originate from REST in this demo.
6. `npm run dev` (watch) or `npm start`

### Quick API smoke-test

```bash
curl -sS -X POST "$BASE_URL/call" \
  -H 'content-type: application/json' \
  -d '{
    "agent_number": "+918000000001",
    "customer_number": "+918000000002",
    "agent_language": "english",
    "customer_language": "hindi"
  }'
```

Expected `HTTP 202` with `{ session_id, conference: "tr-…", state: "dialing_agent" }`.

### Health probes

```
GET /health/live   → { ok, active_sessions, uptime_s, ts }
GET /health/ready  → { ready }
```

---

## CRM JSON contract (`POST /call`)

```json
{
  "agent_number": "+918000000001",
  "customer_number": "+918000000002",
  "agent_language": "english",
  "customer_language": "hindi"
}
```

Semantics:

| Field | Description |
| --- | --- |
| `agent_number` | Primary telecaller (dialed **first**) — must be canonical **E.164** `+country…`. |
| `customer_number` | Called after the agent answers (`CUSTOMER_DIAL_DELAY_MS`). |
| `agent_language` | Language the interpreter **targets toward the agent** (what the agent listens to). Normally `english`. |
| `customer_language` | Language the interpreter **targets toward the customer**. Normally `hindi`. |
| `"auto"` | Allowed on **exactly one** side; the resolver infers paired languages (defaults for EN↔HI style pairs). |

The engine derives two OpenAI output tags:

```
customer_mic → translator → OPENAI(audio.output.language = agent_listen_tag) → injected on agent websocket
agent_mic → translator → OPENAI(audio.output.language = customer_listen_tag) → injected on customer websocket
```

Aliases supported: `english`→`en`, `hindi`→`hi`, plus arbitrary two-letter ISO-639 codes.

---

## Docker & Compose

```
docker compose up --build
```

Provide `.env` beside `docker-compose.yml`. Containers listen on `:3000` internally; mapped via `${PORT:-3000}` host binding.

Production checklist:

1. TLS termination at LB + **`trust proxy`** (already enabled once inside Express).
2. Pin `NODE_ENV=production`, lock dependencies (`npm shrinkwrap` / CI cache).
3. Enable `PLIVO_VALIDATE_SIGNATURES=true` once your public webhook URL lining matches Plivo signatures.
4. Monitor OpenAI realtime spend + Plivo concurrency.

---

## Project layout (`src`)

| Path | Responsibility |
| --- | --- |
| `server.js` | HTTP server, attaches Plivo `ws` upgrades, graceful `SIGTERM` teardown |
| `config/` | `env.js` validates & documents runtime tuning |
| `routes/` | Express mounts (`call`, webhooks, health) |
| `controllers/` | Thin HTTP adapters |
| `services/` | `CallOrchestrator`, `TranslationSession`, `SessionRegistry` (conference + session semantics) |
| `plivo/` | REST originate & stream starters, webhook signature helper, `<Conference>` XML |
| `openai/` | `OpenAiRealtimeTranslation` websocket façade |
| `websocket/` | Plivo streaming gateway + heartbeat pings |
| `utils/` | Resampling, codecs, RMS VAD, E.164 sanity, locale mapping |

Bonus features wired in README narrative:

| Bonus | Implementation |
| --- | --- |
| Lightweight language autopair (`auto`) | `utils/language.js#resolveTranslationTargets` |
| Conference session manager | `SessionRegistry` + orchestrator TTL sweeps |
| Heartbeat pings | Interval `ping()` on `/ws/plivo` clients |
| Active session counters | `/health/live#active_sessions` |
| Graceful shutdown | Snapshots open sessions → destroy → hang up legs |

---

## Error handling behaviours

| Symptom | Behaviour |
| --- | --- |
| Invalid CRM JSON | `400` `{ error }` |
| Number format bad | Throws before Plivo originates |
| Plivo originates failure | Logs + `400` Plivo-layer error surfaced |
| Stream REST failure | Session `destroy('stream_start_failed')` cascades hangs |
| OpenAI websocket drop | Translator logs warnings; SIP legs still bridged unless media fails |
| WebSocket teardown | Translator session ends + hang-ups via teardown hook |
| Setup timeout (`CALL_SETUP_TIMEOUT_MS`) | Drops stuck sessions ringing customer |

---

## Limitations / next hardening paths

| Topic | Guidance |
| --- | --- |
| Horizontal scale | Shard by caller domain or SIP trunk; replicate **state externally** before multi-pod rollout |
| Silence tail trimming | RMS threshold tune per locale / handset |
| Resampling artefacts | Upgrade to libsamplerate / FFmpeg if quality demands |
| OpenAI outages | Fallback path (second provider) intentionally omitted per product scope |

---

## Support matrix

Telephony stacks evolve — always confirm **Stream bidirectional + Conference muted** behaviour in your tenant’s Plivo release notes before go-live.

OpenAI model strings change; keep translation + voice model env vars configurable.

---

## License

Use and modify per your CRM integration policy — no transitive obligations included in this repository snapshot.
