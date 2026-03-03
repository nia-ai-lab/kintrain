"""KinTrain AgentCore Runtime entrypoint based server.

Runtime contract:
- /ping and /invocations are managed by BedrockAgentCoreApp
- streaming payload is emitted as SSE data frames (JSON per frame)
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from collections.abc import AsyncGenerator
from zoneinfo import ZoneInfo


MODEL_ID = os.getenv("MODEL_ID", "global.anthropic.claude-sonnet-4-6")
MEMORY_ID = os.getenv("MEMORY_ID", "").strip()
AWS_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-northeast-1"
APP_TIMEZONE_DEFAULT = os.getenv("APP_TIMEZONE_DEFAULT", "Asia/Tokyo")
SYSTEM_PROMPT_FILE_PATH = os.getenv("SYSTEM_PROMPT_FILE_PATH", "config/prompts/system-prompt.ja.txt")
PERSONA_FILE_PATH = os.getenv("PERSONA_FILE_PATH", "config/prompts/PERSONA.md")
SOUL_FILE_PATH = os.getenv("SOUL_FILE_PATH", "config/prompts/SOUL.md")
STREAM_CHUNK_CHAR_SIZE = int(os.getenv("STREAM_CHUNK_CHAR_SIZE", "24"))
VENDOR_DIR = (Path(__file__).resolve().parent / "vendor").resolve()
LTM_ENABLED = os.getenv("LTM_RETRIEVAL_ENABLED", "true").strip().lower() != "false"
LTM_PREFERENCES_TOP_K = int(os.getenv("LTM_PREFERENCES_TOP_K", "5"))
LTM_PREFERENCES_MIN_SCORE = float(os.getenv("LTM_PREFERENCES_MIN_SCORE", "0.7"))
LTM_FACTS_TOP_K = int(os.getenv("LTM_FACTS_TOP_K", "10"))
LTM_FACTS_MIN_SCORE = float(os.getenv("LTM_FACTS_MIN_SCORE", "0.3"))
LTM_SUMMARIES_TOP_K = int(os.getenv("LTM_SUMMARIES_TOP_K", "5"))
LTM_SUMMARIES_MIN_SCORE = float(os.getenv("LTM_SUMMARIES_MIN_SCORE", "0.5"))

if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

def _read_prompt(path_str: str) -> str:
    path = Path(path_str)
    if not path.is_absolute():
        path = (Path(__file__).resolve().parent / path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def _load_system_prompt_template() -> str:
    soul = _read_prompt(SOUL_FILE_PATH)
    persona = _read_prompt(PERSONA_FILE_PATH)
    system_prompt = _read_prompt(SYSTEM_PROMPT_FILE_PATH)
    return "\n\n".join([soul, persona, system_prompt]).strip()


SYSTEM_PROMPT_TEMPLATE = _load_system_prompt_template()
VARIABLE_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}")

try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp, BedrockAgentCoreContext  # type: ignore
except Exception:
    from bedrock_agentcore import BedrockAgentCoreApp  # type: ignore
    from bedrock_agentcore.runtime import BedrockAgentCoreContext  # type: ignore

app = BedrockAgentCoreApp()


def _get_strands_dependencies() -> tuple[Any, Any, Any, Any, Any]:
    try:
        from bedrock_agentcore.memory.integrations.strands.config import (  # type: ignore
            AgentCoreMemoryConfig,
            RetrievalConfig,
        )
        from bedrock_agentcore.memory.integrations.strands.session_manager import (  # type: ignore
            AgentCoreMemorySessionManager,
        )
        from strands import Agent  # type: ignore
        from strands.models import BedrockModel  # type: ignore

        return Agent, BedrockModel, AgentCoreMemoryConfig, RetrievalConfig, AgentCoreMemorySessionManager
    except Exception as exc:
        raise RuntimeError(
            "Required Strands/AgentCore packages are not available. "
            "Install `strands-agents` and `bedrock-agentcore` in runtime package."
        ) from exc


def _extract_bearer_token(authorization_header: str | None) -> str | None:
    if not authorization_header:
        return None
    value = authorization_header.strip()
    if not value.lower().startswith("bearer "):
        return None
    token = value[7:].strip()
    if not token:
        return None
    return token


def _decode_jwt_payload_without_verification(token: str) -> dict[str, Any]:
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_part = parts[1]
        payload_part += "=" * ((4 - len(payload_part) % 4) % 4)
        payload_raw = base64.urlsafe_b64decode(payload_part.encode("utf-8"))
        payload = json.loads(payload_raw.decode("utf-8"))
        if isinstance(payload, dict):
            return payload
        return {}
    except Exception:
        return {}


def _resolve_actor_id(authorization_header: str | None) -> str:
    token = _extract_bearer_token(authorization_header)
    if token:
        claims = _decode_jwt_payload_without_verification(token)
        sub = claims.get("sub")
        if isinstance(sub, str) and sub.strip():
            return sub.strip()
    raise RuntimeError("Cognito access token sub claim is required for actorId.")


def _get_request_headers_from_context() -> dict[str, str]:
    headers = BedrockAgentCoreContext.get_request_headers()
    if not headers:
        return {}
    return {str(key).lower(): str(value) for key, value in headers.items()}


def _response_to_text(response: Any) -> str:
    if isinstance(response, str):
        return response
    if isinstance(response, dict):
        for key in ("text", "content", "output_text", "message"):
            value = response.get(key)
            if isinstance(value, str) and value.strip():
                return value
    for attr in ("text", "content", "output_text", "message"):
        value = getattr(response, attr, None)
        if isinstance(value, str) and value.strip():
            return value
    text = str(response)
    return text if isinstance(text, str) else ""


def _chunk_text(text: str, chunk_size: int) -> list[str]:
    if not text:
        return []
    size = max(1, chunk_size)
    return [text[index : index + size] for index in range(0, len(text), size)]


def _build_retrieval_config(retrieval_config_class: Any) -> dict[str, Any]:
    if not LTM_ENABLED:
        return {}
    return {
        "/preferences/{actorId}": retrieval_config_class(
            top_k=max(1, LTM_PREFERENCES_TOP_K),
            relevance_score=max(0.0, min(1.0, LTM_PREFERENCES_MIN_SCORE)),
        ),
        "/facts/{actorId}": retrieval_config_class(
            top_k=max(1, LTM_FACTS_TOP_K),
            relevance_score=max(0.0, min(1.0, LTM_FACTS_MIN_SCORE)),
        ),
        "/summaries/{actorId}/{sessionId}": retrieval_config_class(
            top_k=max(1, LTM_SUMMARIES_TOP_K),
            relevance_score=max(0.0, min(1.0, LTM_SUMMARIES_MIN_SCORE)),
        ),
    }


def _to_non_empty_string(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return fallback


def _extract_metadata(payload: dict[str, Any]) -> dict[str, Any]:
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        return metadata
    return {}


def _resolve_timezone(timezone_id: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone_id)
    except Exception:
        try:
            return ZoneInfo(APP_TIMEZONE_DEFAULT)
        except Exception:
            return ZoneInfo("UTC")


def _resolve_template_value(path: str, context: dict[str, Any]) -> Any:
    parts = [part for part in path.split(".") if part]
    if not parts:
        return None
    current: Any = context
    for part in parts:
        if isinstance(current, dict) and part in current:
            current = current[part]
            continue
        return None
    return current


def _render_template(template: str, context: dict[str, Any]) -> str:
    def replacer(match: re.Match[str]) -> str:
        key = match.group(1)
        value = _resolve_template_value(key, context)
        if value is None:
            return match.group(0)
        if isinstance(value, str):
            return value
        return str(value)

    return VARIABLE_PATTERN.sub(replacer, template)


def _build_system_prompt(payload: dict[str, Any]) -> str:
    metadata = _extract_metadata(payload)

    user_profile = metadata.get("userProfile") if isinstance(metadata.get("userProfile"), dict) else {}
    ai_profile = metadata.get("aiCharacterProfile") if isinstance(metadata.get("aiCharacterProfile"), dict) else {}

    user_name = _to_non_empty_string(user_profile.get("userName"), "未設定")
    user_sex = _to_non_empty_string(user_profile.get("sex"), "no-answer")
    user_birth_date = _to_non_empty_string(user_profile.get("birthDate"), "未設定")
    user_height_cm_raw = user_profile.get("heightCm")
    if isinstance(user_height_cm_raw, (int, float)):
        user_height_cm = str(user_height_cm_raw)
    else:
        user_height_cm = "未設定"

    user_time_zone_id = _to_non_empty_string(user_profile.get("timeZoneId"), "")
    if not user_time_zone_id:
        user_time_zone_id = _to_non_empty_string(metadata.get("timeZoneId"), APP_TIMEZONE_DEFAULT)

    character_name = _to_non_empty_string(
        ai_profile.get("characterName"), _to_non_empty_string(metadata.get("characterName"), "ニャル子")
    )
    tone_preset = _to_non_empty_string(ai_profile.get("tonePreset"), "friendly-coach")
    character_description = _to_non_empty_string(ai_profile.get("characterDescription"), "未設定")
    speech_ending = _to_non_empty_string(ai_profile.get("speechEnding"), "未設定")

    now_utc = datetime.now(timezone.utc)
    resolved_zone = _resolve_timezone(user_time_zone_id)
    now_user_tz = now_utc.astimezone(resolved_zone)

    context = {
        "userName": user_name,
        "userSex": user_sex,
        "userBirthDate": user_birth_date,
        "userHeightCm": user_height_cm,
        "userTimeZoneId": user_time_zone_id,
        "characterName": character_name,
        "tonePreset": tone_preset,
        "characterDescription": character_description,
        "speechEnding": speech_ending,
        "backendNowUtcRfc3339": now_utc.isoformat(),
        "backendNowUserTzRfc3339": now_user_tz.isoformat(),
        "backendTimeZoneId": user_time_zone_id,
        "user": {
            "userName": user_name,
            "sex": user_sex,
            "birthDate": user_birth_date,
            "heightCm": user_height_cm,
            "timeZoneId": user_time_zone_id,
        },
        "ai": {
            "characterName": character_name,
            "tonePreset": tone_preset,
            "characterDescription": character_description,
            "speechEnding": speech_ending,
        },
        "backend": {
            "nowUtcRfc3339": now_utc.isoformat(),
            "nowUserTzRfc3339": now_user_tz.isoformat(),
            "timeZoneId": user_time_zone_id,
        },
    }
    return _render_template(SYSTEM_PROMPT_TEMPLATE, context)


def _run_agent_turn(session_id: str, actor_id: str, user_text: str, system_prompt: str) -> str:
    if not MEMORY_ID:
        raise RuntimeError("MEMORY_ID is not configured in runtime environment variables.")

    Agent, BedrockModel, AgentCoreMemoryConfig, RetrievalConfig, AgentCoreMemorySessionManager = _get_strands_dependencies()
    model = BedrockModel(model_id=MODEL_ID)

    memory_config = AgentCoreMemoryConfig(
        memory_id=MEMORY_ID,
        actor_id=actor_id,
        session_id=session_id,
        retrieval_config=_build_retrieval_config(RetrievalConfig),
    )

    with AgentCoreMemorySessionManager(
        agentcore_memory_config=memory_config,
        region_name=AWS_REGION,
    ) as session_manager:
        agent = Agent(
            model=model,
            system_prompt=system_prompt,
            session_manager=session_manager,
        )
        response = agent(user_text)
        return _response_to_text(response)


async def _stream_runtime_response(payload: dict[str, Any], context: Any) -> AsyncGenerator[dict[str, Any], None]:
    user_text = str(payload.get("inputText", "")).strip()
    if not user_text:
        raise ValueError("inputText is required")

    context_session_id = getattr(context, "session_id", None)
    session_id = str(payload.get("sessionId") or context_session_id or uuid.uuid4())

    headers = _get_request_headers_from_context()
    authorization_header = headers.get("authorization")
    actor_id = _resolve_actor_id(authorization_header)
    system_prompt = _build_system_prompt(payload)

    yield {"event": "status", "status": "thinking", "message": "考え中です..."}
    output_text = await asyncio.to_thread(
        _run_agent_turn,
        session_id=session_id,
        actor_id=actor_id,
        user_text=user_text,
        system_prompt=system_prompt,
    )
    for chunk in _chunk_text(output_text, STREAM_CHUNK_CHAR_SIZE):
        yield {"event": "chunk", "chunk": chunk}
    yield {"event": "done", "runtimeSessionId": session_id}


@app.entrypoint
async def invoke(payload: dict[str, Any], context: Any) -> AsyncGenerator[dict[str, Any], None]:
    try:
        async for event in _stream_runtime_response(payload, context):
            yield event
    except Exception as exc:
        fallback_session_id = str(payload.get("sessionId") or getattr(context, "session_id", None) or uuid.uuid4())
        yield {"event": "status", "status": "error", "message": f"{type(exc).__name__}: {exc}"}
        yield {"event": "done", "runtimeSessionId": fallback_session_id}


if __name__ == "__main__":
    app.run()
