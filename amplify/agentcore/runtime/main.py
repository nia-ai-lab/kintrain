"""KinTrain AgentCore Runtime HTTP server.

Runtime contract:
- GET /ping
- POST /invocations (SSE stream response)
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


MODEL_ID = os.getenv("MODEL_ID", "anthropic.claude-opus-4-6-v1")
APP_TIMEZONE_DEFAULT = os.getenv("APP_TIMEZONE_DEFAULT", "Asia/Tokyo")
SYSTEM_PROMPT_FILE_PATH = os.getenv("SYSTEM_PROMPT_FILE_PATH", "config/prompts/system-prompt.ja.txt")
PERSONA_FILE_PATH = os.getenv("PERSONA_FILE_PATH", "config/prompts/PERSONA.md")
SOUL_FILE_PATH = os.getenv("SOUL_FILE_PATH", "config/prompts/SOUL.md")
RUNTIME_HOST = os.getenv("RUNTIME_HOST", "0.0.0.0")
RUNTIME_PORT = int(os.getenv("RUNTIME_PORT", "8080"))
MAX_HISTORY_MESSAGES = int(os.getenv("MAX_HISTORY_MESSAGES", "10"))
VENDOR_DIR = (Path(__file__).resolve().parent / "vendor").resolve()

if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))


SESSION_MESSAGES: dict[str, list[dict[str, str]]] = {}


def _read_prompt(path_str: str) -> str:
    path = Path(path_str)
    if not path.is_absolute():
        path = (Path(__file__).resolve().parent / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def _load_system_prompt() -> str:
    soul = _read_prompt(SOUL_FILE_PATH)
    persona = _read_prompt(PERSONA_FILE_PATH)
    system_prompt = _read_prompt(SYSTEM_PROMPT_FILE_PATH)
    return "\n\n".join([soul, persona, system_prompt]).strip()


SYSTEM_PROMPT = _load_system_prompt()


def _get_bedrock_client() -> Any:
    region = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-northeast-1"
    try:
        import boto3  # type: ignore

        return boto3.client("bedrock-runtime", region_name=region)
    except Exception as exc:
        raise RuntimeError("boto3 is not available in runtime package.") from exc


def _to_model_messages(session_id: str, user_text: str) -> list[dict[str, Any]]:
    history = SESSION_MESSAGES.get(session_id, [])
    compact_history = history[-MAX_HISTORY_MESSAGES:]
    messages: list[dict[str, Any]] = []
    for item in compact_history:
        role = item.get("role", "user")
        text = item.get("text", "")
        if not text:
            continue
        messages.append({"role": role, "content": [{"text": text}]})
    messages.append({"role": "user", "content": [{"text": user_text}]})
    return messages


def _append_history(session_id: str, role: str, text: str) -> None:
    if not text:
        return
    history = SESSION_MESSAGES.setdefault(session_id, [])
    history.append({"role": role, "text": text})
    if len(history) > MAX_HISTORY_MESSAGES * 2:
        SESSION_MESSAGES[session_id] = history[-(MAX_HISTORY_MESSAGES * 2) :]


def _iter_model_text(session_id: str, user_text: str) -> tuple[list[str], str]:
    client = _get_bedrock_client()
    messages = _to_model_messages(session_id, user_text)
    _append_history(session_id, "user", user_text)

    response = client.converse_stream(
        modelId=MODEL_ID,
        system=[{"text": SYSTEM_PROMPT}],
        messages=messages,
        inferenceConfig={"maxTokens": 900, "temperature": 0.6},
    )

    chunks: list[str] = []
    assembled_text = ""
    for event in response.get("stream", []):
        if "contentBlockDelta" not in event:
            continue
        delta = event["contentBlockDelta"].get("delta", {})
        text = delta.get("text")
        if not text:
            continue
        chunks.append(text)
        assembled_text += text

    _append_history(session_id, "assistant", assembled_text)
    return chunks, assembled_text


def _sse(event_name: str, payload: dict[str, Any]) -> bytes:
    event_line = f"event: {event_name}\n"
    data_line = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    return (event_line + data_line).encode("utf-8")


class RuntimeHandler(BaseHTTPRequestHandler):
    server_version = "KinTrainRuntime/1.0"
    protocol_version = "HTTP/1.1"

    def _json_response(self, status_code: int, payload: dict[str, Any]) -> None:
        content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(content)
        self.wfile.flush()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/ping":
            self._json_response(404, {"message": "Not Found"})
            return

        self._json_response(
            200,
            {
                "ok": True,
                "modelId": MODEL_ID,
                "timezoneDefault": APP_TIMEZONE_DEFAULT,
                "promptLoaded": bool(SYSTEM_PROMPT),
            },
        )

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/invocations":
            self._json_response(404, {"message": "Not Found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            self._json_response(400, {"message": "Invalid JSON payload"})
            return

        user_text = str(payload.get("inputText", "")).strip()
        session_id = str(payload.get("sessionId") or uuid.uuid4())
        if not user_text:
            self._json_response(400, {"message": "inputText is required"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

        try:
            self.wfile.write(_sse("status", {"status": "thinking", "message": "考え中です..."}))
            self.wfile.flush()

            chunks, _ = _iter_model_text(session_id, user_text)
            if not chunks:
                self.wfile.write(
                    _sse(
                        "chunk",
                        {"chunk": "現時点で十分な情報を生成できませんでした。入力内容を変えて再試行してください。"},
                    )
                )
                self.wfile.flush()
            else:
                for chunk in chunks:
                    self.wfile.write(_sse("chunk", {"chunk": chunk}))
                    self.wfile.flush()

            self.wfile.write(_sse("done", {"runtimeSessionId": session_id}))
            self.wfile.flush()
        except Exception as exc:
            self.wfile.write(_sse("status", {"status": "error", "message": f"{type(exc).__name__}: {exc}"}))
            self.wfile.write(_sse("done", {"runtimeSessionId": session_id}))
            self.wfile.flush()

    def log_message(self, fmt: str, *args: Any) -> None:
        # Keep runtime logs concise.
        print(f"{self.address_string()} - {fmt % args}")


def run() -> None:
    server = ThreadingHTTPServer((RUNTIME_HOST, RUNTIME_PORT), RuntimeHandler)
    print(
        json.dumps(
            {
                "message": "KinTrain runtime server started",
                "host": RUNTIME_HOST,
                "port": RUNTIME_PORT,
                "modelId": MODEL_ID,
            },
            ensure_ascii=False,
        )
    )
    server.serve_forever()


if __name__ == "__main__":
    run()
