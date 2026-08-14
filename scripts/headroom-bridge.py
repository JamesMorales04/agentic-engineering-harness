#!/usr/bin/env python3
"""Small, line-oriented JSON bridge for the pinned Headroom SDK.

The bridge deliberately uses Headroom's public ``headroom.compression`` API,
never its agent wrappers or memory store.  stdout is reserved for one JSON
response; diagnostics belong on stderr so the Node adapter can reject framing
corruption deterministically.
"""

from __future__ import annotations

import hashlib
import json
import sys
from typing import Any


def fail(message: str, code: str = "HEADROOM_BRIDGE_ERROR") -> None:
    print(json.dumps({"version": 1, "error": {"code": code, "message": message}}), flush=True)


def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
        if not isinstance(request, dict) or request.get("version") != 1:
            fail("request version must be 1", "INVALID_REQUEST")
            return 2
        operation = request.get("operation", "compress")
        from headroom import __version__

        if operation == "doctor":
            print(json.dumps({"version": 1, "providerVersion": __version__}), flush=True)
            return 0
        if operation != "compress":
            fail(f"unsupported operation: {operation}", "INVALID_REQUEST")
            return 2

        content = request.get("content")
        source_sha256 = request.get("sourceSha256")
        max_tokens = request.get("maxTokens")
        if not isinstance(content, str) or not content:
            fail("content must be a non-empty string", "INVALID_REQUEST")
            return 2
        if not isinstance(source_sha256, str) or hashlib.sha256(content.encode()).hexdigest() != source_sha256:
            fail("sourceSha256 does not match content", "SOURCE_HASH_MISMATCH")
            return 2
        if not isinstance(max_tokens, int) or max_tokens < 1:
            fail("maxTokens must be a positive integer", "INVALID_REQUEST")
            return 2

        # UniversalCompressor is the documented local SDK entry point.  CCR is
        # disabled: AEH persists and authorizes the original fragment itself.
        from headroom.compression import UniversalCompressor, UniversalCompressorConfig

        original_tokens = max(1, len(content) // 4)
        target_ratio = min(1.0, max_tokens / original_tokens)
        compressor = UniversalCompressor(
            UniversalCompressorConfig(
                use_magika=False,
                use_kompress=False,
                ccr_enabled=False,
                compression_ratio_target=target_ratio,
            )
        )
        result = compressor.compress(content)
        response: dict[str, Any] = {
            "version": 1,
            "content": result.compressed,
            "originalTokens": result.tokens_before,
            "compressedTokens": result.tokens_after,
            "reversible": False,
            "providerVersion": __version__,
            "sourceSha256": source_sha256,
        }
        print(json.dumps(response, separators=(",", ":")), flush=True)
        return 0
    except Exception as error:  # pragma: no cover - exercised by contract tests
        print(f"headroom bridge failure: {error}", file=sys.stderr, flush=True)
        fail(str(error), "SDK_RUNTIME_FAILURE")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
