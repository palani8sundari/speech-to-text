"""Bridge between the browser WebSocket and the Gemini Live transcription API.

Browser  --(binary 16 kHz PCM16 mono chunks)-->  FastAPI  --> Gemini Live
Browser  <--(JSON {type: interim|final, text})--  FastAPI  <-- Gemini Live

The API key never leaves the server.
"""
import asyncio
import json
import logging
import os

from fastapi import WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

log = logging.getLogger("live")

MODEL = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.5-transcribe-live")
AUDIO_MIME = "audio/pcm;rate=16000"


def gemini_configured() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


def _config(language_codes: list[str]) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["TEXT"],
        # Empty list => automatic language detection incl. code-switching (Hindi + English).
        input_audio_transcription=types.AudioTranscriptionConfig(language_codes=language_codes),
    )


async def handle_live_socket(ws: WebSocket, language: str) -> None:
    await ws.accept()
    if not gemini_configured():
        await ws.send_json({"type": "error", "message": "GEMINI_API_KEY is not set on the server."})
        await ws.close()
        return

    codes = [] if language in ("", "auto") else [c for c in language.split(",") if c]
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options={"api_version": "v1beta"})

    try:
        async with client.aio.live.connect(model=MODEL, config=_config(codes)) as session:
            await ws.send_json({"type": "ready", "model": MODEL})

            async def pump_audio() -> None:
                while True:
                    msg = await ws.receive()
                    if msg["type"] == "websocket.disconnect":
                        raise WebSocketDisconnect()
                    if msg.get("bytes"):
                        await session.send_realtime_input(
                            audio=types.Blob(data=msg["bytes"], mime_type=AUDIO_MIME)
                        )
                    elif msg.get("text"):
                        data = json.loads(msg["text"])
                        if data.get("type") == "stop":
                            await session.send_realtime_input(audio_stream_end=True)

            async def pump_transcripts() -> None:
                while True:
                    async for response in session.receive():
                        sc = response.server_content
                        if not sc:
                            continue
                        if sc.interim_input_transcription and sc.interim_input_transcription.text:
                            await ws.send_json({"type": "interim", "text": sc.interim_input_transcription.text})
                        if sc.input_transcription and sc.input_transcription.text:
                            await ws.send_json({"type": "final", "text": sc.input_transcription.text})

            tasks = [asyncio.create_task(pump_audio()), asyncio.create_task(pump_transcripts())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
            for t in pending:
                t.cancel()
            for t in done:
                exc = t.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # surface upstream errors to the UI
        log.exception("Live session failed")
        try:
            await ws.send_json({"type": "error", "message": f"Transcription service error: {exc}"})
            await ws.close()
        except Exception:
            pass
