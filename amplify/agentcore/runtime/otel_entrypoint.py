"""AgentCore runtime OTEL entrypoint.

Runs the runtime app through OpenTelemetry auto-instrumentation.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    runtime_dir = Path(__file__).resolve().parent
    vendor_dir = runtime_dir / "vendor"
    vendor_bin_dir = vendor_dir / "bin"
    otel_command = vendor_bin_dir / "opentelemetry-instrument"

    current_path = os.environ.get("PATH", "")
    os.environ["PATH"] = (
        f"{vendor_bin_dir}:{current_path}" if current_path else str(vendor_bin_dir)
    )

    current_pythonpath = os.environ.get("PYTHONPATH", "")
    os.environ["PYTHONPATH"] = (
        f"{vendor_dir}:{current_pythonpath}" if current_pythonpath else str(vendor_dir)
    )

    command = [
        str(otel_command if otel_command.exists() else "opentelemetry-instrument"),
        sys.executable,
        str(runtime_dir / "main.py"),
    ]
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    try:
        main()
    except FileNotFoundError:
        print(
            "opentelemetry-instrument command was not found. "
            "Ensure aws-opentelemetry-distro is packaged in the runtime artifact.",
            file=sys.stderr,
        )
        raise
