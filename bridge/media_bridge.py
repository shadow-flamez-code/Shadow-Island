"""Windows media bridge for Dynamic Island.

The bridge is intentionally isolated from the volume bridge: on Windows,
comtypes/pycaw and WinRT thumbnail streams do not reliably coexist in one
process. This process only talks to WinRT.

Protocol: newline-delimited JSON on stdout/stdin.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
from typing import Any

try:
    from winrt.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    )
    from winrt.windows.storage.streams import DataReader
except Exception as exc:  # pragma: no cover - surfaced to the desktop app
    sys.stderr.write(f"BRIDGE_IMPORT_ERROR: {exc}\n")
    sys.stderr.flush()
    raise


POLL_SECONDS = 0.7
MANAGER_REFRESH_SECONDS = 20.0
ARTWORK_RETRY_SECONDS = 3.0
ARTWORK_BACKOFF_SECONDS = 15.0
MAX_ARTWORK_BYTES = 4 * 1024 * 1024

APP_NAMES = (
    ("spotify", "Spotify"),
    ("msedge", "Microsoft Edge"),
    ("chrome", "Google Chrome"),
    ("firefox", "Firefox"),
    ("zunemusic", "Media Player"),
    ("media player", "Media Player"),
    ("vlc", "VLC"),
    ("foobar", "foobar2000"),
    ("musicbee", "MusicBee"),
    ("tidal", "TIDAL"),
    ("amazon music", "Amazon Music"),
    ("deezer", "Deezer"),
    ("youtube music", "YouTube Music"),
    ("apple music", "Apple Music"),
    ("itunes", "iTunes"),
)

_running = True
_manager: Any = None
_manager_created = 0.0
_last_art_key = ""
_art_attempted_at = 0.0
_art_failures = 0


def emit(payload: dict[str, Any]) -> None:
    try:
        sys.stdout.write(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        )
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        global _running
        _running = False


def log(message: str) -> None:
    try:
        sys.stderr.write(f"{message}\n")
        sys.stderr.flush()
    except OSError:
        pass


def friendly_app_name(app_id: str | None) -> str:
    if not app_id:
        return "Media"
    lowered = app_id.lower()
    for needle, label in APP_NAMES:
        if needle in lowered:
            return label
    if "!" in app_id:
        app_id = app_id.split("!", 1)[0]
    app_id = app_id.rsplit("\\", 1)[-1]
    if app_id.lower().endswith(".exe"):
        app_id = app_id[:-4]
    return app_id or "Media"


async def get_manager(force: bool = False) -> Any:
    global _manager, _manager_created
    now = time.monotonic()
    if force or _manager is None or now - _manager_created > MANAGER_REFRESH_SECONDS:
        try:
            _manager = await asyncio.wait_for(
                SessionManager.request_async(), timeout=6.0
            )
            _manager_created = now
        except Exception as exc:
            log(f"MANAGER_ERROR: {exc}")
            _manager = None
    return _manager


async def read_artwork(
    thumbnail: Any, track_key: str, is_new_track: bool
) -> tuple[str | None, str | None]:
    global _last_art_key, _art_attempted_at, _art_failures
    if not thumbnail:
        return None, None
    if not is_new_track and track_key == _last_art_key:
        return None, None
    now = time.monotonic()
    # After repeated failures, keep retrying on a slower cadence instead of
    # giving up for the whole process lifetime: thumbnail streams are often
    # not ready on the first few polls (app still warming up, race with seek).
    spacing = ARTWORK_BACKOFF_SECONDS if _art_failures >= 3 else ARTWORK_RETRY_SECONDS
    if now - _art_attempted_at < spacing:
        return None, None
    _art_attempted_at = now
    stream = None
    reader = None
    try:
        stream = await asyncio.wait_for(thumbnail.open_read_async(), timeout=4.0)
        size = int(stream.size)
        if size <= 0 or size > MAX_ARTWORK_BYTES:
            _art_failures += 1
            return None, None
        reader = DataReader(stream)
        await asyncio.wait_for(reader.load_async(size), timeout=4.0)
        data = bytes(reader.read_buffer(size))
        content_type = stream.content_type or "image/png"
        _last_art_key = track_key
        _art_failures = 0
        return (
            f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}",
            content_type,
        )
    except Exception as exc:
        _art_failures += 1
        log(f"ARTWORK_ERROR: {exc}")
        return None, None
    finally:
        try:
            if reader is not None:
                reader.close()
        except Exception:
            pass
        try:
            if stream is not None:
                stream.close()
        except Exception:
            pass


async def pick_session(manager: Any) -> Any:
    """Prefer a playing session, then any session carrying metadata,
    then Windows' current session. This keeps the island tracking what
    the user actually hears when several apps hold SMTC sessions."""
    try:
        sessions = manager.get_sessions()
    except Exception:
        sessions = []
    best = None
    best_score = -1
    for session in sessions or []:
        if session is None:
            continue
        score = 0
        try:
            info = session.get_playback_info()
            if int(info.playback_status) == 4:  # playing
                score += 4
            elif int(info.playback_status) == 5:  # paused
                score += 1
        except Exception:
            pass
        try:
            position = session.get_timeline_properties().position.total_seconds()
            if position > 0:
                score += 1
        except Exception:
            pass
        try:
            current = manager.get_current_session()
            if session is current:
                score += 2
        except Exception:
            pass
        if score > best_score:
            best_score = score
            best = session
    if best is not None:
        return best
    try:
        return manager.get_current_session()
    except Exception:
        return None


async def read_media() -> dict[str, Any] | None:
    global _last_art_key, _art_failures
    manager = await get_manager()
    if manager is None:
        return None
    session = await pick_session(manager)
    if session is None:
        _last_art_key = ""
        _art_failures = 0
        return None

    try:
        media = await asyncio.wait_for(
            session.try_get_media_properties_async(), timeout=4.0
        )
    except Exception as exc:
        log(f"PROPS_ERROR: {exc}")
        return None

    try:
        info = session.get_playback_info()
        timeline = session.get_timeline_properties()
        controls = info.controls
        status_code = int(info.playback_status)
        title = (media.title or "").strip()
        artist = (media.artist or "").strip()
        album = (media.album_title or "").strip()
        app_id = session.source_app_user_model_id or ""
        track_key = "\u241f".join((app_id, title, artist, album))
        is_new_track = track_key != _last_art_key and _last_art_key != ""

        if is_new_track:
            _last_art_key = ""
            _art_failures = 0

        artwork, artwork_type = await read_artwork(
            media.thumbnail, track_key, is_new_track
        )

        duration = max(0.0, float(timeline.end_time.total_seconds()))
        position = max(0.0, float(timeline.position.total_seconds()))
        if status_code == 4 and duration > 0:
            # TimelineProperties.position is a snapshot taken at
            # last_updated_time. Chrome/Edge often freeze that snapshot for
            # 10+ seconds while audio keeps playing, so extrapolate by the age
            # of the snapshot instead of only trusting ages under five seconds.
            last_updated = timeline.last_updated_time
            if last_updated is not None:
                try:
                    age = time.time() - last_updated.timestamp()
                    if 0 < age < 3600:
                        position = min(duration, position + age)
                except Exception:
                    pass
            position = min(duration, position)

        return {
            "active": bool(title or artist or album),
            "trackKey": track_key,
            "app": friendly_app_name(app_id),
            "appId": app_id,
            "title": title or "Unknown track",
            "artist": artist or friendly_app_name(app_id),
            "album": album,
            "playing": status_code == 4,
            "status": {
                0: "closed",
                1: "opened",
                2: "changing",
                3: "stopped",
                4: "playing",
                5: "paused",
            }.get(status_code, "unknown"),
            "position": position,
            "duration": duration,
            "canPlay": bool(controls and controls.is_play_enabled),
            "canPause": bool(controls and controls.is_pause_enabled),
            "canToggle": bool(controls and controls.is_play_pause_toggle_enabled),
            "canPrevious": bool(controls and controls.is_previous_enabled),
            "canNext": bool(controls and controls.is_next_enabled),
            "canSeek": bool(controls and controls.is_playback_position_enabled),
            "artwork": artwork,
            "artworkType": artwork_type,
        }
    except Exception as exc:
        log(f"MEDIA_ERROR: {exc}")
        return None


async def sample_state() -> dict[str, Any]:
    media = await read_media()
    return {
        "type": "media-state",
        "ts": int(time.time() * 1000),
        "media": media,
    }


async def current_media_session() -> Any:
    manager = await get_manager()
    if manager is None:
        return None
    return await pick_session(manager)


async def handle_command(command: dict[str, Any]) -> None:
    command_id = command.get("id")
    action = command.get("action")
    ok = False
    detail = ""

    try:
        session = await current_media_session()
        if session is None:
            detail = "no active media session"
        elif action == "seek":
            seconds = max(0.0, float(command.get("position", 0.0)))
            ok = bool(
                await asyncio.wait_for(
                    session.try_change_playback_position_async(
                        int(seconds * 10_000_000)
                    ),
                    timeout=4.0,
                )
            )
        elif action == "toggle":
            ok = bool(
                await asyncio.wait_for(
                    session.try_toggle_play_pause_async(), timeout=4.0
                )
            )
        elif action == "play":
            ok = bool(await asyncio.wait_for(session.try_play_async(), timeout=4.0))
        elif action == "pause":
            ok = bool(await asyncio.wait_for(session.try_pause_async(), timeout=4.0))
        elif action == "next":
            ok = bool(
                await asyncio.wait_for(session.try_skip_next_async(), timeout=4.0)
            )
        elif action == "previous":
            ok = bool(
                await asyncio.wait_for(session.try_skip_previous_async(), timeout=4.0)
            )
        elif action == "stop":
            ok = bool(await asyncio.wait_for(session.try_stop_async(), timeout=4.0))
        elif action == "refresh":
            ok = True
        else:
            detail = "unknown media action"
    except Exception as exc:
        detail = str(exc)
        log(f"COMMAND_ERROR: {action}: {exc}")

    if command_id is not None:
        emit({"type": "ack", "id": command_id, "ok": ok, "detail": detail})

    # Push a fresh frame so the UI reacts immediately after a transport action.
    if action in {"seek", "toggle", "play", "pause", "next", "previous", "stop", "refresh"}:
        await asyncio.sleep(0.1)
        emit(await sample_state())


async def command_loop() -> None:
    global _running
    loop = asyncio.get_running_loop()
    while _running:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
        except Exception:
            break
        if not line:
            _running = False
            break
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except json.JSONDecodeError:
            log("COMMAND_JSON_ERROR")
            continue
        if isinstance(command, dict):
            await handle_command(command)


async def state_loop() -> None:
    global _running
    first = True
    while _running:
        try:
            emit(await sample_state())
        except Exception as exc:
            log(f"STATE_ERROR: {exc}")
            emit(
                {
                    "type": "media-state",
                    "ts": int(time.time() * 1000),
                    "media": None,
                    "error": str(exc),
                }
            )
        await asyncio.sleep(0.25 if first else POLL_SECONDS)
        first = False


async def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    emit({"type": "ready", "service": "media", "version": 1, "pid": os.getpid()})
    state_task = asyncio.create_task(state_loop())
    command_task = asyncio.create_task(command_loop())
    done, pending = await asyncio.wait(
        {state_task, command_task}, return_when=asyncio.FIRST_COMPLETED
    )
    for task in pending:
        task.cancel()
    for task in done:
        try:
            task.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log(f"TASK_ERROR: {exc}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except KeyboardInterrupt:
        pass
