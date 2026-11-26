# Vaani: Real-time Speech to Text

A web app that transcribes speech **as you talk**, including **multilingual and code-mixed speech** such as Hindi and English in the same sentence (*"Aaj ka meeting schedule kya hai, can you remind me at 5 PM?"*). Saved transcriptions go into **PostgreSQL** and appear in a history dashboard with full **CRUD**: create, read and search, edit, and delete.

**Stack:** Python 3.12 · FastAPI · SQLAlchemy 2 · PostgreSQL · Gemini Live API (`gemini-3.5-transcribe-live`) · plain HTML/CSS/JS (no build step)

---

## Features

| Area | What it does |
|---|---|
| Real-time STT | The mic streams 16 kHz PCM over a WebSocket. Interim words appear while you speak and are replaced by the final text at each pause. |
| Multilingual | Auto language detection with code-switching (Hindi + English). Language hints are also available (hi-IN, en-IN, ta-IN). |
| Dashboard | Searchable history with stats (transcripts, words, minutes) and paginated loading. |
| CRUD | `POST / GET / PUT / DELETE /api/transcriptions`, used through edit and delete dialogs in the UI. |
| Text to Speech | A "Listen" button on any transcript reads it aloud with the browser's built-in speech synthesis. It picks a Hindi voice for Devanagari text. |
| Fallback engine | With no Gemini key set, the app uses the browser's Web Speech API in Chrome or Edge, so the demo still works. |
| UX | Light and dark themes, live waveform, keyboard shortcut (Space toggles recording), accessible dialogs and focus states, responsive down to 375 px, respects reduced-motion settings. |

## Architecture

```
Browser (AudioWorklet → 16 kHz PCM16, 100 ms chunks)
   │  WebSocket /ws/transcribe            ▲ JSON {type: interim|final, text}
   ▼                                      │
FastAPI ── google-genai Live session ──► Gemini Live (gemini-3.5-transcribe-live)
   │
   └── REST /api/transcriptions ──► SQLAlchemy ──► PostgreSQL
```

The Gemini API key stays on the server. The browser only talks to this backend.

```
app/
  main.py      FastAPI app: REST CRUD, stats, WebSocket route, static hosting
  live.py      Browser ↔ Gemini Live audio/transcript bridge
  db.py        SQLAlchemy engine + Transcription model
  schemas.py   Pydantic request/response models
static/
  index.html   UI (studio + history dashboard)
  styles.css   Design tokens, light/dark themes
  app.js       Recording, live transcript, CRUD dashboard, TTS
  pcm-worklet.js  Resamples mic audio to 16 kHz PCM16
```

## Run locally

```bash
# 1. PostgreSQL: create a database
createdb speech_to_text

# 2. Python environment
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 3. Configuration
cp .env.example .env
#   DATABASE_URL=postgresql://<user>:<pass>@localhost:5432/speech_to_text
#   GEMINI_API_KEY=<free key from https://aistudio.google.com/apikey>

# 4. Start
uvicorn app.main:app --reload
# open http://localhost:8000
```

Tables are created automatically on startup.

## Deploy (Render, free tier)

1. Push this repo to GitHub.
2. In Render, go to **New + → Blueprint** and pick the repo. `render.yaml` creates the web service and a PostgreSQL database.
3. Set `GEMINI_API_KEY` in the service's **Environment** tab.

The `Dockerfile` also works on Railway, Fly.io, Cloud Run, or any other container host. It needs `DATABASE_URL` and `GEMINI_API_KEY`.

> The microphone only works over **HTTPS** (or on `localhost`). All the hosts above serve HTTPS by default.

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Status and whether Gemini is configured |
| GET | `/api/transcriptions?q=&limit=&offset=` | List and search (newest first) |
| GET | `/api/transcriptions/stats` | Totals |
| GET | `/api/transcriptions/{id}` | Fetch one |
| POST | `/api/transcriptions` | Create `{text, title?, language?, engine?, duration_seconds?}` |
| PUT | `/api/transcriptions/{id}` | Update `{title?, text?, language?}` |
| DELETE | `/api/transcriptions/{id}` | Delete |
| WS | `/ws/transcribe?language=auto` | Send binary PCM16 at 16 kHz and `{"type":"stop"}`. Receive `ready`, `interim`, `final` and `error` messages. |

Interactive docs: `/docs`.

## Notes and limitations

- A Gemini Live session lasts up to about 10 minutes. The UI stops automatically at 9.5 minutes.
- No speaker diarization or word timestamps, because the model doesn't provide them.
- The browser fallback engine supports Chrome and Edge only.
