"""KinTrain AgentCore Runtime entrypoint based server.

Runtime contract:
- /ping and /invocations are managed by BedrockAgentCoreApp
- the runtime is invoked only through the AI chat API (IAM inbound auth)
- the caller forwards the user's Cognito access token in a custom header; the
  runtime verifies it itself and derives the Memory actor from the verified sub
- streaming payload is emitted as SSE data frames (JSON per frame)

Platform version V2 restores every instance from a snapshot taken after module
import, so heavy imports and static configuration live at module scope and
per-request values (time, ids, credentials) are produced inside the handler.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from collections.abc import AsyncGenerator, Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


MODEL_ID = os.getenv("MODEL_ID", "global.anthropic.claude-sonnet-5-5")
MODEL_MAX_TOKENS = int(os.getenv("MODEL_MAX_TOKENS", "16000"))
MODEL_EFFORT = os.getenv("MODEL_EFFORT", "").strip().lower()
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
USER_POOL_ID = os.getenv("USER_POOL_ID", "").strip()
USER_POOL_CLIENT_IDS = frozenset(
    value.strip() for value in os.getenv("USER_POOL_CLIENT_IDS", "").split(",") if value.strip()
)
REQUIRED_TOKEN_SCOPE = "aws.cognito.signin.user.admin"
USER_ACCESS_TOKEN_HEADER = "x-amzn-bedrock-agentcore-runtime-custom-user-access-token"

if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

import jwt  # noqa: E402  # type: ignore
from bedrock_agentcore.memory.integrations.strands.config import (  # noqa: E402  # type: ignore
    AgentCoreMemoryConfig,
    RetrievalConfig,
)
from bedrock_agentcore.memory.integrations.strands.session_manager import (  # noqa: E402  # type: ignore
    AgentCoreMemorySessionManager,
)
from bedrock_agentcore.runtime import BedrockAgentCoreApp, BedrockAgentCoreContext  # noqa: E402  # type: ignore
from strands import Agent  # noqa: E402  # type: ignore
from strands.models import BedrockModel  # noqa: E402  # type: ignore
from strands.tools.mcp import MCPClient  # noqa: E402  # type: ignore

COGNITO_ISSUER = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{USER_POOL_ID}" if USER_POOL_ID else ""
# Keys are fetched lazily on the first request and cached; nothing is fetched before the snapshot.
JWKS_CLIENT = jwt.PyJWKClient(f"{COGNITO_ISSUER}/.well-known/jwks.json", cache_keys=True) if COGNITO_ISSUER else None


class UserFacingError(Exception):
    """An error whose message is safe to show to the end user."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


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

app = BedrockAgentCoreApp()


def verify_user_access_token(token: str) -> str:
    """Verify a Cognito access token and return its sub.

    The token signature, issuer, expiry, token_use, client and scope are all
    checked, so a forged or tampered token can never select another user's Memory.
    """
    if JWKS_CLIENT is None or not USER_POOL_CLIENT_IDS:
        raise RuntimeError("USER_POOL_ID and USER_POOL_CLIENT_IDS must be configured.")
    try:
        signing_key = JWKS_CLIENT.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=COGNITO_ISSUER,
            leeway=30,
            options={"require": ["exp", "iat", "sub", "token_use", "client_id"], "verify_aud": False},
        )
    except jwt.PyJWKClientConnectionError:
        # Could not reach the Cognito key endpoint; this is not the user's fault.
        raise
    except jwt.PyJWTError as exc:
        raise UserFacingError("unauthorized", "ログインの有効期限が切れました。ページを再読み込みしてください。") from exc

    scopes = str(claims.get("scope", "")).split()
    sub = claims.get("sub")
    if (
        claims.get("token_use") != "access"
        or claims.get("client_id") not in USER_POOL_CLIENT_IDS
        or REQUIRED_TOKEN_SCOPE not in scopes
        or not isinstance(sub, str)
        or not sub.strip()
    ):
        raise UserFacingError("unauthorized", "ログインの有効期限が切れました。ページを再読み込みしてください。")
    return sub.strip()


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


def _resolve_user_access_token(headers: dict[str, str]) -> str:
    token = headers.get(USER_ACCESS_TOKEN_HEADER, "").strip()
    if not token:
        raise UserFacingError("unauthorized", "ログイン情報を確認できませんでした。ページを再読み込みしてください。")
    return token


def _resolve_runtime_session_id(payload: dict[str, Any], context: Any) -> str:
    context_session_id = getattr(context, "session_id", None)
    if context_session_id is None:
        context_session_id = payload.get("sessionId")
    session_id = str(context_session_id or "").strip()
    if not session_id or len(session_id) < 33:
        raise RuntimeError("A valid runtime session id is required (minimum 33 characters).")
    return session_id


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
    # A web tool is exposed to the model only when explicitly enabled; the generic
    # HTTP tool can otherwise reach arbitrary URLs from model-chosen arguments.
    if not ENABLE_WEB_SEARCH_TOOL:
        return []

    provider = WEB_SEARCH_PROVIDER.strip().lower()
    if not provider or provider == "http_request":
        from strands_tools.http_request import http_request  # type: ignore

        return [http_request]

    if provider == "tavily":
        if not _to_non_empty_string(os.getenv("TAVILY_API_KEY")):
            raise RuntimeError("TAVILY_API_KEY is required when WEB_SEARCH_PROVIDER=tavily.")
        from strands_tools.tavily import tavily_search  # type: ignore

        return [tavily_search]

    if provider == "exa":
        if not _to_non_empty_string(os.getenv("EXA_API_KEY")):
            raise RuntimeError("EXA_API_KEY is required when WEB_SEARCH_PROVIDER=exa.")
        from strands_tools.exa import exa_search  # type: ignore

        return [exa_search]

    raise RuntimeError("WEB_SEARCH_PROVIDER must be one of: http_request, tavily, exa.")


def _build_model() -> Any:
    model_config: dict[str, Any] = {"model_id": MODEL_ID, "max_tokens": MODEL_MAX_TOKENS}
    if MODEL_EFFORT in {"low", "medium", "high", "xhigh", "max"}:
        model_config["additional_request_fields"] = {"output_config": {"effort": MODEL_EFFORT}}
    return BedrockModel(region_name=AWS_REGION, **model_config)


def _to_user_facing_error(exc: BaseException) -> UserFacingError:
    if isinstance(exc, UserFacingError):
        return exc
    name = type(exc).__name__
    text = str(exc)
    if "Throttling" in name or "Throttling" in text or "TooManyRequests" in text:
        return UserFacingError("busy", "AIコーチが混み合っています。少し待ってからもう一度送信してください。")
    if "Timeout" in name or "timed out" in text.lower():
        return UserFacingError("timeout", "AIコーチの応答に時間がかかりすぎました。もう一度送信してください。")
    return UserFacingError("internal", "AIコーチの応答中にエラーが発生しました。もう一度送信してください。")


async def _run_agent_turn_stream(
    session_id: str,
    actor_id: str,
    user_text: str,
    system_prompt: str,
    user_access_token: str,
) -> AsyncGenerator[tuple[str, str], None]:
    """Run one agent turn and yield ("delta", text) and ("tool", name) items."""
    if not MEMORY_ID:
        raise RuntimeError("MEMORY_ID is not configured in runtime environment variables.")

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
        tools: list[Any] = [*_load_web_search_tools()]
        mcp_url = _normalize_mcp_gateway_url(MCP_GATEWAY_URL)
        if ENABLE_MCP_TOOLS and mcp_url:
            # The Gateway verifies this token again and scopes every tool to its sub.
            tools.append(
                MCPClient(
                    url=mcp_url,
                    headers={"Authorization": f"Bearer {user_access_token}"},
                    startup_timeout=20,
                )
            )

        agent = Agent(
            model=_build_model(),
            system_prompt=(
                f"{system_prompt}\n\n"
                "When calling a save_daily_* tool without an explicit date, include timeZoneId from the user profile."
            ),
            session_manager=session_manager,
            tools=tools or None,
            # The default handler prints every token to stdout, which would copy
            # conversations into CloudWatch Logs.
            callback_handler=None,
        )

        announced_tool_ids: set[str] = set()
        async for event in agent.stream_async(user_text):
            if not isinstance(event, Mapping):
                continue
            if event.get("force_stop"):
                raise RuntimeError(f"Agent stopped: {event.get('force_stop_reason')}")
            text = event.get("data")
            if isinstance(text, str) and text:
                yield ("delta", text)
            tool_use = event.get("current_tool_use")
            if isinstance(tool_use, Mapping):
                tool_use_id = tool_use.get("toolUseId")
                tool_name = tool_use.get("name")
                if isinstance(tool_use_id, str) and isinstance(tool_name, str) and tool_use_id not in announced_tool_ids:
                    announced_tool_ids.add(tool_use_id)
                    yield ("tool", tool_name)


async def _stream_runtime_response(payload: dict[str, Any], context: Any) -> AsyncGenerator[dict[str, Any], None]:
    user_text = str(payload.get("inputText", "")).strip()
    if not user_text:
        raise UserFacingError("invalid_request", "メッセージを入力してください。")

    session_id = _resolve_runtime_session_id(payload, context)
    headers = _get_request_headers_from_context(context)
    user_access_token = _resolve_user_access_token(headers)
    actor_id = verify_user_access_token(user_access_token)
    system_prompt = _build_system_prompt(payload)

    yield {"event": "status", "status": "thinking"}
    loop = asyncio.get_running_loop()
    last_flush_at = loop.time()
    buffered = ""
    async for kind, value in _run_agent_turn_stream(
        session_id=session_id,
        actor_id=actor_id,
        user_text=user_text,
        system_prompt=system_prompt,
        user_access_token=user_access_token,
    ):
        if kind == "tool":
            if buffered:
                yield {"event": "delta", "text": buffered}
                buffered = ""
            yield {"event": "tool", "name": value}
            continue

        buffered += value
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
            yield {"event": "delta", "text": buffered}
            buffered = ""
            last_flush_at = now

    if buffered:
        yield {"event": "delta", "text": buffered}
    yield {"event": "done"}


@app.entrypoint
async def invoke(payload: dict[str, Any], context: Any) -> AsyncGenerator[dict[str, Any], None]:
    try:
        async for event in _stream_runtime_response(payload, context):
            yield event
    except Exception as exc:
        error = _to_user_facing_error(exc)
        print(f"runtime-turn-failed code={error.code} type={type(exc).__name__}: {exc}")
        yield {"event": "error", "code": error.code, "message": error.message}


if __name__ == "__main__":
    app.run()
