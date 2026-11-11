"""Windows master-volume / audio bridge for Dynamic Island.

Kept in a separate process from the media bridge because comtypes and WinRT
thumbnail streams conflict on Windows.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from typing import Any

try:
    from pycaw.pycaw import AudioUtilities
    try:
        from pycaw.constants import AudioDeviceState, CLSID_CPolicyConfigClient
        from pycaw.api.policyconfig import IPolicyConfig
        import comtypes
    except Exception:  # older pycaw without policy config
        IPolicyConfig = None
except Exception as exc:  # pragma: no cover - surfaced to the desktop app
    sys.stderr.write(f"BRIDGE_IMPORT_ERROR: {exc}\n")
    sys.stderr.flush()
    raise


POLL_SECONDS = 0.28
HEARTBEAT_SECONDS = 2.0
AUDIO_INFO_SECONDS = 8.0

_running = True
_command_queue: "queue.Queue[dict[str, Any]]" = queue.Queue()
_volume_interface: Any = None
_volume_created = 0.0
_mic_interface: Any = None
_mic_created = 0.0
_audio_info: dict[str, Any] = {
    "output": "",
    "outputId": "",
    "outputs": [],
    "microphone": {"name": "Microphone", "muted": False, "available": False},
}
_audio_info_at = 0.0
_last_audio_signature: tuple | None = None


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


def get_volume_interface() -> Any:
    global _volume_interface, _volume_created
    now = time.monotonic()
    if _volume_interface is None or now - _volume_created > 8.0:
        device = AudioUtilities.GetSpeakers()
        _volume_interface = device.EndpointVolume
        _volume_created = now
    return _volume_interface


def get_microphone_interface() -> Any:
    global _mic_interface, _mic_created
    now = time.monotonic()
    if _mic_interface is None or now - _mic_created > 8.0:
        device = AudioUtilities.GetMicrophone()
        # pycaw returns a raw IMMDevice pointer for the microphone; wrap it the
        # same way GetSpeakers() does so .EndpointVolume is available.
        if device is not None and not hasattr(device, "EndpointVolume"):
            device = AudioUtilities.CreateDevice(device)
        _mic_interface = device
        _mic_created = now
    return _mic_interface


def read_volume() -> dict[str, Any]:
    try:
        endpoint = get_volume_interface()
        return {
            "level": max(0.0, min(1.0, float(endpoint.GetMasterVolumeLevelScalar()))),
            "muted": bool(endpoint.GetMute()),
            "available": True,
        }
    except Exception as exc:
        log(f"VOLUME_READ_ERROR: {exc}")
        global _volume_interface
        _volume_interface = None
        return {"level": 0.0, "muted": False, "available": False}


def set_volume(level: float) -> bool:
    try:
        get_volume_interface().SetMasterVolumeLevelScalar(
            max(0.0, min(1.0, float(level))), None
        )
        return True
    except Exception as exc:
        log(f"VOLUME_SET_ERROR: {exc}")
        global _volume_interface
        _volume_interface = None
        return False


def set_muted(muted: bool) -> bool:
    try:
        get_volume_interface().SetMute(bool(muted), None)
        return True
    except Exception as exc:
        log(f"MUTE_SET_ERROR: {exc}")
        global _volume_interface
        _volume_interface = None
        return False


def read_microphone() -> dict[str, Any]:
    global _mic_interface
    try:
        device = get_microphone_interface()
        endpoint = device.EndpointVolume
        name = _audio_info.get("microphone", {}).get("name", "Microphone")
        try:
            friendly = str(getattr(device, "FriendlyName", "") or "").strip()
            if friendly:
                name = friendly
        except Exception:
            pass
        return {
            "name": name,
            "muted": bool(endpoint.GetMute()),
            "available": True,
        }
    except Exception as exc:
        log(f"MIC_READ_ERROR: {exc}")
        _mic_interface = None
        return {
            "name": _audio_info.get("microphone", {}).get("name", "Microphone"),
            "muted": False,
            "available": False,
        }


def set_microphone_muted(muted: bool) -> bool:
    global _mic_interface
    try:
        get_microphone_interface().EndpointVolume.SetMute(bool(muted), None)
        return True
    except Exception as exc:
        log(f"MIC_SET_ERROR: {exc}")
        _mic_interface = None
        return False


def set_default_output(device_id: str) -> bool:
    """Switch the default playback device through IPolicyConfig."""
    if not IPolicyConfig or not device_id:
        return False
    try:
        policy = comtypes.CoCreateInstance(
            CLSID_CPolicyConfigClient, IPolicyConfig, comtypes.CLSCTX_ALL
        )
        for role in (0, 1, 2):  # console, multimedia, communications
            policy.SetDefaultEndpoint(device_id, role)
        global _volume_interface
        _volume_interface = None
        refresh_audio_info(force=True)
        return True
    except Exception as exc:
        log(f"OUTPUT_SET_ERROR: {exc}")
        return False


def refresh_audio_info(force: bool = False) -> dict[str, Any]:
    global _audio_info, _audio_info_at
    now = time.monotonic()
    if not force and now - _audio_info_at < AUDIO_INFO_SECONDS:
        return _audio_info
    _audio_info_at = now
    try:
        current = AudioUtilities.GetSpeakers()
        outputs: list[dict[str, str]] = []
        seen: set[str] = set()
        microphone_name = ""
        for device in AudioUtilities.GetAllDevices():
            try:
                if device.state != AudioDeviceState.Active:
                    continue
                name = str(device.FriendlyName or "").strip()
                device_id = str(device.id or "")
                if not name or name in seen:
                    continue
                seen.add(name)
                if device_id.startswith("{0.0.0."):
                    outputs.append({"id": device_id, "name": name})
                elif not microphone_name:
                    microphone_name = name
            except Exception:
                continue
        mic = read_microphone()
        if microphone_name:
            mic["name"] = microphone_name
        _audio_info = {
            "output": str(getattr(current, "FriendlyName", "") or "Speakers"),
            "outputId": str(getattr(current, "id", "") or ""),
            "outputs": outputs,
            "microphone": mic,
        }
    except Exception as exc:
        log(f"AUDIO_INFO_ERROR: {exc}")
    return _audio_info


def audio_signature() -> tuple:
    audio = _audio_info
    mic = audio.get("microphone", {})
    return (
        audio.get("output", ""),
        bool(mic.get("muted")),
        bool(mic.get("available")),
        tuple(item.get("name", "") for item in audio.get("outputs", [])),
    )


def command_reader() -> None:
    global _running
    while _running:
        try:
            line = sys.stdin.readline()
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
            _command_queue.put(command)


def build_state() -> dict[str, Any]:
    return {
        "type": "volume-state",
        "ts": int(time.time() * 1000),
        "volume": read_volume(),
        "audio": refresh_audio_info(),
    }


def emit_state() -> dict[str, Any]:
    payload = build_state()
    emit(payload)
    return payload["volume"]


def handle_command(command: dict[str, Any]) -> None:
    command_id = command.get("id")
    kind = command.get("type")
    ok = False
    detail = ""
    try:
        if kind == "volume":
            ok = set_volume(float(command.get("value", 0.0)))
        elif kind == "mute":
            ok = set_muted(bool(command.get("value", True)))
        elif kind == "toggle-mute":
            current = read_volume()
            ok = set_muted(not current["muted"])
        elif kind == "mic-mute":
            ok = set_microphone_muted(bool(command.get("value", True)))
        elif kind == "toggle-mic":
            current = read_microphone()
            ok = set_microphone_muted(not current["muted"])
        elif kind == "output":
            ok = set_default_output(str(command.get("deviceId", "")))
        elif kind == "refresh":
            ok = True
        else:
            detail = "unknown command"
    except Exception as exc:
        detail = str(exc)
        log(f"COMMAND_ERROR: {kind}: {exc}")
    if command_id is not None:
        emit({"type": "ack", "id": command_id, "ok": ok, "detail": detail})
    emit_state()


def main() -> int:
    global _last_audio_signature
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    emit({"type": "ready", "service": "volume", "version": 2, "pid": os.getpid()})
    threading.Thread(target=command_reader, name="volume-commands", daemon=True).start()

    refresh_audio_info(force=True)
    last_signature: tuple[float, bool] | None = None
    last_emit = 0.0
    while _running:
        while not _command_queue.empty():
            try:
                handle_command(_command_queue.get_nowait())
            except queue.Empty:
                break
        volume = read_volume()
        signature = (round(float(volume["level"]), 4), bool(volume["muted"]))
        audio = refresh_audio_info()
        audio_sig = audio_signature()
        now = time.monotonic()
        if (
            signature != last_signature
            or audio_sig != _last_audio_signature
            or now - last_emit >= HEARTBEAT_SECONDS
        ):
            emit(
                {
                    "type": "volume-state",
                    "ts": int(time.time() * 1000),
                    "volume": volume,
                    "audio": audio,
                }
            )
            last_signature = signature
            _last_audio_signature = audio_sig
            last_emit = now
        time.sleep(POLL_SECONDS)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
