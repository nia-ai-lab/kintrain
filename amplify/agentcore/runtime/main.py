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
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from collections.abc import AsyncGenerator
from collections.abc import Mapping
from zoneinfo import ZoneInfo


MODEL_ID = os.getenv("MODEL_ID", "global.anthropic.claude-sonnet-4-6")
MEMORY_ID = os.getenv("MEMORY_ID", "").strip()
AWS_REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-northeast-1"
APP_TIMEZONE_DEFAULT = os.getenv("APP_TIMEZONE_DEFAULT", "Asia/Tokyo")
SYSTEM_PROMPT_FILE_PATH = os.getenv("SYSTEM_PROMPT_FILE_PATH", "config/prompts/system-prompt.ja.txt")
PERSONA_FILE_PATH = os.getenv("PERSONA_FILE_PATH", "config/prompts/PERSONA.md")
SOUL_FILE_PATH = os.getenv("SOUL_FILE_PATH", "config/prompts/SOUL.md")
STREAM_CHUNK_CHAR_SIZE = int(os.getenv("STREAM_CHUNK_CHAR_SIZE", "40"))
STREAM_FLUSH_INTERVAL_MS = int(os.getenv("STREAM_FLUSH_INTERVAL_MS", "250"))
STREAM_MIN_CHARS_FOR_INTERVAL_FLUSH = int(os.getenv("STREAM_MIN_CHARS_FOR_INTERVAL_FLUSH", "12"))
MCP_GATEWAY_URL = os.getenv("MCP_GATEWAY_URL", "").strip()
ENABLE_MCP_TOOLS = os.getenv("ENABLE_MCP_TOOLS", "true").strip().lower() != "false"
ENABLE_WEB_SEARCH_TOOL = os.getenv("ENABLE_WEB_SEARCH_TOOL", "false").strip().lower() == "true"
WEB_SEARCH_PROVIDER = os.getenv("WEB_SEARCH_PROVIDER", "http_request").strip().lower()
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


def _get_mcp_dependencies() -> tuple[Any, Any]:
    try:
        from mcp.client.streamable_http import streamablehttp_client  # type: ignore
        from strands.tools.mcp import MCPClient  # type: ignore

        return MCPClient, streamablehttp_client
    except Exception:
        from mcp.client.streamable_http import streamablehttp_client  # type: ignore
        from strands.tools.mcp.mcp_client import MCPClient  # type: ignore

        return MCPClient, streamablehttp_client


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


def _normalize_header_mapping(headers_obj: Any) -> dict[str, str]:
    if not headers_obj:
        return {}
    if isinstance(headers_obj, Mapping):
        items = headers_obj.items()
    elif hasattr(headers_obj, "items"):
        items = headers_obj.items()
    else:
        return {}
    return {str(key).lower(): str(value) for key, value in items}


def _get_request_headers_from_context(context: Any) -> dict[str, str]:
    context_headers = _normalize_header_mapping(getattr(context, "request_headers", None))
    if context_headers:
        return context_headers

    fallback_headers = _normalize_header_mapping(BedrockAgentCoreContext.get_request_headers())
    return fallback_headers


def _resolve_authorization_header(headers: dict[str, str]) -> str | None:
    custom_authorization = headers.get("x-amzn-bedrock-agentcore-runtime-custom-authorization")
    if isinstance(custom_authorization, str) and custom_authorization.strip():
        return custom_authorization.strip()

    authorization = headers.get("authorization")
    if isinstance(authorization, str) and authorization.strip():
        return authorization.strip()
    return None


def _resolve_runtime_session_id(payload: dict[str, Any], context: Any) -> str:
    context_session_id = getattr(context, "session_id", None)
    if context_session_id is None:
        context_session_id = payload.get("sessionId")
    session_id = str(context_session_id or "").strip()
    if not session_id or len(session_id) < 33:
        raise RuntimeError("A valid runtime session id is required (minimum 33 characters).")
    return session_id


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


def _get_nested_mapping_value(mapping: Mapping[str, Any], path: tuple[str, ...]) -> Any:
    current: Any = mapping
    for key in path:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _extract_event_text(event: Any) -> str:
    if isinstance(event, str):
        return event

    mapping: Mapping[str, Any] | None = event if isinstance(event, Mapping) else None
    if mapping is None and hasattr(event, "model_dump"):
        try:
            dumped = event.model_dump()
            if isinstance(dumped, Mapping):
                mapping = dumped
        except Exception:
            mapping = None
    if mapping is None and hasattr(event, "__dict__"):
        raw = getattr(event, "__dict__", None)
        if isinstance(raw, Mapping):
            mapping = raw

    if mapping is not None:
        for path in (
            ("contentBlockDelta", "delta", "text"),
            ("delta", "text"),
            ("delta",),
            ("chunk",),
            ("text",),
            ("output_text",),
            ("content",),
            ("message",),
        ):
            value = _get_nested_mapping_value(mapping, path)
            if isinstance(value, str) and value:
                return value

        content_list = mapping.get("content")
        if isinstance(content_list, list):
            fragments: list[str] = []
            for item in content_list:
                if isinstance(item, Mapping):
                    text = item.get("text")
                    if isinstance(text, str) and text:
                        fragments.append(text)
            if fragments:
                return "".join(fragments)

    for attr in ("text", "delta", "chunk", "content", "message"):
        value = getattr(event, attr, None)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, Mapping):
            nested_text = value.get("text")
            if isinstance(nested_text, str) and nested_text:
                return nested_text

    return ""


def _is_sentence_break(buffer: str) -> bool:
    if not buffer:
        return False
    return buffer.endswith(("\n", "。", "！", "？", ".", "!", "?"))


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


def _normalize_mcp_gateway_url(raw_url: str) -> str:
    url = raw_url.strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/mcp"):
        return url
    return f"{url}/mcp"


def _to_non_empty_string(value: Any, fallback: str = "") -> str:
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return fallback


def _resolve_tone_profile(tone_preset: str) -> dict[str, str]:
    normalized = tone_preset.strip().lower()
    if normalized == "polite":
        return {
            "toneLabel": "丁寧",
            "toneInstruction": "敬語を使い、配慮ある柔らかい表現で答える。",
            "styleDos": "丁寧語を使う。提案は穏やかに述べる。断定しすぎず配慮を示す。",
            "styleDonts": "強い命令口調。荒い表現。過度にくだけた話し方。",
        }
    if normalized == "strict-coach":
        return {
            "toneLabel": "コーチ強め",
            "toneInstruction": "結論を先に示し、甘やかさず、短く明確に答える。",
            "styleDos": "優先順位を明確にする。次の行動をはっきり示す。曖昧さを減らす。",
            "styleDonts": "攻撃的な表現。人格否定。説教調で長くなること。",
        }
    return {
        "toneLabel": "フレンドリー",
        "toneInstruction": "親しみやすく前向きに、短く実用的に答える。",
        "styleDos": "軽い励ましを入れる。話しやすい口調にする。実行しやすい提案を示す。",
        "styleDonts": "馴れ馴れしすぎる表現。長い雑談。幼すぎる言い回し。",
    }


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
        ai_profile.get("characterName"), _to_non_empty_string(metadata.get("characterName"), "AIコーチ")
    )
    tone_preset = _to_non_empty_string(ai_profile.get("tonePreset"), "friendly-coach")
    character_description = _to_non_empty_string(ai_profile.get("characterDescription"), "優しく見守りAIコーチロボ")
    speech_ending = _to_non_empty_string(ai_profile.get("speechEnding"), "です。ます。")
    tone_profile = _resolve_tone_profile(tone_preset)

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
            "toneLabel": tone_profile["toneLabel"],
            "toneInstruction": tone_profile["toneInstruction"],
            "styleDos": tone_profile["styleDos"],
            "styleDonts": tone_profile["styleDonts"],
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


def _load_web_search_tools() -> list[Any]:
    provider = WEB_SEARCH_PROVIDER.strip().lower()
    if not provider or provider == "http_request":
        from strands_tools.http_request import http_request  # type: ignore

        return [http_request]

    if provider == "tavily":
        if not ENABLE_WEB_SEARCH_TOOL:
            raise RuntimeError("ENABLE_WEB_SEARCH_TOOL must be true when WEB_SEARCH_PROVIDER=tavily.")
        if not _to_non_empty_string(os.getenv("TAVILY_API_KEY")):
            raise RuntimeError("TAVILY_API_KEY is required when WEB_SEARCH_PROVIDER=tavily.")
        from strands_tools.tavily import tavily_search  # type: ignore

        return [tavily_search]

    if provider == "exa":
        if not ENABLE_WEB_SEARCH_TOOL:
            raise RuntimeError("ENABLE_WEB_SEARCH_TOOL must be true when WEB_SEARCH_PROVIDER=exa.")
        if not _to_non_empty_string(os.getenv("EXA_API_KEY")):
            raise RuntimeError("EXA_API_KEY is required when WEB_SEARCH_PROVIDER=exa.")
        from strands_tools.exa import exa_search  # type: ignore

        return [exa_search]

    raise RuntimeError(
        "WEB_SEARCH_PROVIDER must be one of: http_request, tavily, exa."
    )


def _list_mcp_tools(mcp_client: Any) -> list[Any]:
    tools: list[Any] = []
    pagination_token: str | None = None
    while True:
        if pagination_token is None:
            page = mcp_client.list_tools_sync()
        else:
            page = mcp_client.list_tools_sync(pagination_token=pagination_token)

        page_tools: list[Any] = []
        try:
            page_tools = list(page)
        except Exception:
            raw_tools = getattr(page, "tools", None)
            if isinstance(raw_tools, list):
                page_tools = raw_tools

        tools.extend(page_tools)
        pagination_token = getattr(page, "pagination_token", None)
        if not pagination_token:
            break
    return tools


async def _run_agent_turn_stream(
    session_id: str,
    actor_id: str,
    user_text: str,
    system_prompt: str,
    authorization_header: str | None,
) -> AsyncGenerator[str, None]:
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
        system_prompt_for_turn = (
            f"{system_prompt}\n\n"
            f"Tool calling rule: MCP tool arguments must include userId=\"{actor_id}\" exactly.\n"
            "When calling save_daily_diary without explicit date, include timeZoneId from user profile."
        )
        web_search_tools = _load_web_search_tools()
        mcp_url = _normalize_mcp_gateway_url(MCP_GATEWAY_URL)
        mcp_context = nullcontext()
        mcp_client = None

        if ENABLE_MCP_TOOLS and mcp_url and authorization_header:
            try:
                MCPClient, streamablehttp_client = _get_mcp_dependencies()
                mcp_client = MCPClient(
                    lambda: streamablehttp_client(
                        url=mcp_url,
                        headers={
                            "Authorization": authorization_header
                        },
                    )
                )
                mcp_context = mcp_client
            except Exception as exc:
                print(f"mcp-client-init-failed: {type(exc).__name__}: {exc}")

        with mcp_context:
            mcp_tools: list[Any] = []
            if mcp_client is not None:
                try:
                    mcp_tools = _list_mcp_tools(mcp_client)
                except Exception as exc:
                    print(f"mcp-tool-list-failed: {type(exc).__name__}: {exc}")

            tools = [*mcp_tools, *web_search_tools]
            agent_kwargs = {
                "model": model,
                "system_prompt": system_prompt_for_turn,
                "session_manager": session_manager,
            }
            if tools:
                agent_kwargs["tools"] = tools
            agent = Agent(**agent_kwargs)
            stream_async = getattr(agent, "stream_async", None)
            if not callable(stream_async):
                raise RuntimeError("Agent stream_async is not available.")

            async for event in stream_async(user_text):
                text = _extract_event_text(event)
                if text:
                    yield text


async def _stream_runtime_response(payload: dict[str, Any], context: Any) -> AsyncGenerator[dict[str, Any], None]:
    user_text = str(payload.get("inputText", "")).strip()
    if not user_text:
        raise ValueError("inputText is required")

    session_id = _resolve_runtime_session_id(payload, context)
    headers = _get_request_headers_from_context(context)
    print(f"runtime-request-headers keys={sorted(headers.keys())}")
    authorization_header = _resolve_authorization_header(headers)
    if not authorization_header:
        raise RuntimeError("Authorization header is required.")
    actor_id = _resolve_actor_id(authorization_header)
    system_prompt = _build_system_prompt(payload)

    yield {"event": "status", "status": "thinking", "message": "考え中です..."}
    loop = asyncio.get_running_loop()
    last_flush_at = loop.time()
    buffered = ""
    async for delta_text in _run_agent_turn_stream(
        session_id=session_id,
        actor_id=actor_id,
        user_text=user_text,
        system_prompt=system_prompt,
        authorization_header=authorization_header,
    ):
        buffered += delta_text
        now = loop.time()
        elapsed_ms = int((now - last_flush_at) * 1000)
        if (
            len(buffered) >= max(1, STREAM_CHUNK_CHAR_SIZE)
            or _is_sentence_break(buffered)
            or (
                elapsed_ms >= max(50, STREAM_FLUSH_INTERVAL_MS)
                and len(buffered) >= max(1, STREAM_MIN_CHARS_FOR_INTERVAL_FLUSH)
            )
        ):
            yield {"event": "chunk", "chunk": buffered}
            buffered = ""
            last_flush_at = now

    if buffered:
        yield {"event": "chunk", "chunk": buffered}
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
