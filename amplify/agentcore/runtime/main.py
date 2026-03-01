"""KinTrain AgentCore Runtime entrypoint (Strands / Python).

MVP implementation note:
- This file is a starting point for Runtime code deployment.
- It keeps model selection in environment variables.
- Prompt files are loaded from external text files (no hardcoded system prompt).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


MODEL_ID = os.getenv("MODEL_ID", "anthropic.claude-opus-4-6-v1")
MCP_GATEWAY_URL = os.getenv("MCP_GATEWAY_URL", "")
SYSTEM_PROMPT_FILE_PATH = os.getenv("SYSTEM_PROMPT_FILE_PATH", "config/prompts/system-prompt.ja.txt")
PERSONA_FILE_PATH = os.getenv("PERSONA_FILE_PATH", "config/prompts/PERSONA.md")
SOUL_FILE_PATH = os.getenv("SOUL_FILE_PATH", "config/prompts/SOUL.md")


def _read_prompt(path_str: str) -> str:
    path = Path(path_str)
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8")


def load_system_prompt() -> str:
    soul = _read_prompt(SOUL_FILE_PATH)
    persona = _read_prompt(PERSONA_FILE_PATH)
    system_prompt = _read_prompt(SYSTEM_PROMPT_FILE_PATH)
    return "\n\n".join([soul, persona, system_prompt]).strip()


def health() -> dict[str, Any]:
    return {
        "ok": True,
        "modelId": MODEL_ID,
        "mcpGatewayConfigured": bool(MCP_GATEWAY_URL),
    }


if __name__ == "__main__":
    payload = {
        "message": "KinTrain AgentCore Runtime bootstrap script",
        "health": health(),
        "promptLoaded": bool(load_system_prompt()),
    }
    print(json.dumps(payload, ensure_ascii=False))
