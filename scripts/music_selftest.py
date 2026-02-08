#!/usr/bin/env python3

from pathlib import Path


def main() -> None:
    sub_path = Path(__file__).resolve().parent.parent / "music" / "Subscription.js"
    src = sub_path.read_text(encoding="utf-8")

    # 1) Regression guard: waitForDirectUrlForPlayback must not recurse into itself when waitMs is null.
    if "await this.waitForDirectUrlForPlayback(track);" in src:
        raise SystemExit(
            "FAIL: waitForDirectUrlForPlayback() contains self-recursion."
        )

    # 2) Regression guard: do not force Range header injection for YouTube/googlevideo direct URL playback.
    # Range is fine if provided by yt-dlp headers, but we should not inject it unconditionally.
    if "normalized['Range'] = 'bytes=0-';" in src:
        raise SystemExit(
            "FAIL: normalizeHeadersForUrl() forces Range: bytes=0- injection."
        )

    print("music_selftest: OK")


if __name__ == "__main__":
    main()

