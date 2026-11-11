"""Windows system telemetry bridge for Dynamic Island.

Emits CPU / memory / GPU / network / battery / privacy telemetry as
newline-delimited JSON. Commands are optional and currently only refresh the
next sample immediately.
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from typing import Any

try:  # Windows-only helpers for the fullscreen probe
    import ctypes
except Exception:  # pragma: no cover
    ctypes = None

try:
    import psutil
except Exception as exc:  # pragma: no cover
    sys.stderr.write(f"BRIDGE_IMPORT_ERROR: {exc}\n")
    sys.stderr.flush()
    raise


POLL_SECONDS = 1.0
GPU_POLL_SECONDS = 2.0
NETWORK_INFO_SECONDS = 12.0
POWER_INFO_SECONDS = 45.0

_running = True
_command_queue: "queue.Queue[dict[str, Any]]" = queue.Queue()
_last_net = None
_last_net_at = 0.0
_last_network_info = {"ssid": "", "type": "Disconnected"}
_last_network_info_at = 0.0
_last_power_mode = ""
_last_power_mode_at = 0.0
_gpu_info = {
    "name": "",
    "usage": None,
    "temperature": None,
    "memoryUsed": None,
    "memoryTotal": None,
    "vendor": "",
    "available": False,
}
_gpu_at = 0.0
_nvidia_smi: str | None = None
_nvidia_checked = False
_cpu_reported = False
_biometric_info = {"available": False, "service": "", "status": ""}
_biometric_at = 0.0


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


def run_hidden(args: list[str], timeout: float = 3.0) -> str:
    try:
        flags = 0x08000000 if os.name == "nt" else 0
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            creationflags=flags,
            check=False,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def find_nvidia_smi() -> str | None:
    global _nvidia_checked, _nvidia_smi
    if _nvidia_checked:
        return _nvidia_smi
    _nvidia_checked = True
    candidates = [
        os.path.join(
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            "NVIDIA Corporation",
            "NVSMI",
            "nvidia-smi.exe",
        ),
        os.path.join(
            os.environ.get("SystemRoot", r"C:\Windows"),
            "System32",
            "nvidia-smi.exe",
        ),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            _nvidia_smi = candidate
            return candidate
    output = run_hidden(["where", "nvidia-smi"], timeout=2)
    if output:
        _nvidia_smi = output.splitlines()[0].strip()
    return _nvidia_smi


def update_gpu(force: bool = False) -> None:
    global _gpu_at
    now = time.monotonic()
    if not force and now - _gpu_at < GPU_POLL_SECONDS:
        return
    _gpu_at = now
    smi = find_nvidia_smi()
    if smi:
        output = run_hidden(
            [
                smi,
                "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ],
            timeout=3.0,
        )
        if output:
            first = output.splitlines()[0]
            parts = [part.strip() for part in first.split(",")]
            if len(parts) >= 5:
                _gpu_info.update(
                    {
                        "name": parts[0],
                        "usage": _num(parts[1]),
                        "temperature": _num(parts[2]),
                        "memoryUsed": _num(parts[3]),
                        "memoryTotal": _num(parts[4]),
                        "vendor": "NVIDIA",
                        "available": True,
                    }
                )
                return
    if not _gpu_info["name"]:
        name = run_hidden(
            [
                "powershell.exe",
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)",
            ],
            timeout=4.0,
        )
        if name:
            vendor = "NVIDIA" if "nvidia" in name.lower() else "AMD" if "amd" in name.lower() or "radeon" in name.lower() else "Intel" if "intel" in name.lower() else ""
            _gpu_info.update({"name": name, "vendor": vendor, "available": True})


def _num(value: Any) -> float | int | None:
    try:
        text = str(value).strip()
        if not text or text.lower() in {"n/a", "[not supported]"}:
            return None
        number = float(text)
        return int(number) if number.is_integer() else round(number, 1)
    except Exception:
        return None


def read_wifi() -> dict[str, str]:
    global _last_network_info, _last_network_info_at
    now = time.monotonic()
    if now - _last_network_info_at < NETWORK_INFO_SECONDS:
        return _last_network_info
    _last_network_info_at = now
    output = run_hidden(["netsh", "wlan", "show", "interfaces"], timeout=3.0)
    ssid = ""
    state = ""
    if output:
        for line in output.splitlines():
            if ":" not in line:
                continue
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            if key in {"SSID", "State"}:
                if key == "SSID":
                    ssid = value
                else:
                    state = value
    if ssid and state.lower() == "connected":
        _last_network_info = {"ssid": ssid, "type": "Wi-Fi"}
    else:
        # No Wi-Fi association. If any non-loopback interface is up, call it
        # Ethernet rather than showing a scarier "disconnected" state.
        active_iface = ""
        try:
            stats = psutil.net_if_stats()
            for name, stat in stats.items():
                lowered = name.lower()
                if stat.isup and not any(x in lowered for x in ("loopback", "vethernet", "virtual", "vpn")):
                    active_iface = name
                    break
        except Exception:
            pass
        _last_network_info = {
            "ssid": active_iface or "No network",
            "type": "Ethernet" if active_iface else "Disconnected",
        }
    return _last_network_info


def read_power_mode() -> str:
    global _last_power_mode, _last_power_mode_at
    now = time.monotonic()
    if now - _last_power_mode_at < POWER_INFO_SECONDS:
        return _last_power_mode
    _last_power_mode_at = now
    output = run_hidden(["powercfg", "/getactivescheme"], timeout=3.0)
    match = re.search(r"\(([^)]+)\)", output)
    if match:
        _last_power_mode = match.group(1)
    return _last_power_mode


def _read_capability(capability: str) -> dict[str, Any]:
    try:
        import winreg
    except Exception:
        return {"active": False, "app": "", "count": 0}

    root = (
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager"
        rf"\ConsentStore\{capability}"
    )
    active: list[tuple[int, str]] = []
    count = 0
    try:
        base = winreg.OpenKey(winreg.HKEY_CURRENT_USER, root)
    except OSError:
        return {"active": False, "app": "", "count": 0}

    def walk(key: Any, depth: int) -> None:
        nonlocal count
        try:
            subkey_count = winreg.QueryInfoKey(key)[0]
        except OSError:
            return
        for index in range(subkey_count):
            try:
                name = winreg.EnumKey(key, index)
                child = winreg.OpenKey(key, name)
            except OSError:
                continue
            try:
                props = {}
                value_count = winreg.QueryInfoKey(child)[1]
                for value_index in range(value_count):
                    try:
                        value_name, value, _ = winreg.EnumValue(child, value_index)
                        props[value_name] = value
                    except OSError:
                        continue
                if "LastUsedTimeStart" in props and "LastUsedTimeStop" in props:
                    count += 1
                    start = int(props.get("LastUsedTimeStart") or 0)
                    stop = int(props.get("LastUsedTimeStop") or 0)
                    if start > 0 and stop == 0:
                        label = name
                        if "NonPackaged" in root or depth > 0:
                            label = name.replace("#", "\\")
                        if label.lower().endswith(".exe"):
                            label = os.path.basename(label)
                        active.append((start, label))
                walk(child, depth + 1)
            finally:
                try:
                    winreg.CloseKey(child)
                except OSError:
                    pass

    try:
        walk(base, 0)
    finally:
        try:
            winreg.CloseKey(base)
        except OSError:
            pass

    active.sort(reverse=True)
    label = os.path.basename(active[0][1]) if active else ""
    return {"active": bool(active), "app": label, "count": len(active)}


_last_privacy: Any = None
_last_privacy_at = 0.0


def read_privacy() -> dict[str, Any]:
    """Privacy consent flags. The registry walk is the most expensive
    part of the poll, so it runs on its own 5-second cadence."""
    global _last_privacy, _last_privacy_at
    now = time.monotonic()
    if _last_privacy is not None and now - _last_privacy_at < 5.0:
        return _last_privacy
    _last_privacy_at = now
    _last_privacy = {
        "webcam": _read_capability("webcam"),
        "microphone": _read_capability("microphone"),
        "location": _read_capability("location"),
    }
    return _last_privacy


def read_biometrics() -> dict[str, Any]:
    global _biometric_info, _biometric_at
    now = time.monotonic()
    if now - _biometric_at < 60.0:
        return _biometric_info
    _biometric_at = now
    try:
        service = psutil.win_service_get("WbioSrvc")
        status = str(service.status() or "")
        _biometric_info = {
            "available": status.lower() == "running",
            "service": "WbioSrvc",
            "status": status,
        }
    except Exception as exc:
        _biometric_info = {
            "available": False,
            "service": "WbioSrvc",
            "status": f"unavailable: {exc}",
        }
    return _biometric_info


_last_battery_info: Any = None
_last_battery_at = 0.0


def read_battery() -> dict[str, Any]:
    """Charging telemetry on a 10-second cadence."""
    global _last_battery_info, _last_battery_at
    now = time.monotonic()
    if _last_battery_info is not None and now - _last_battery_at < 10.0:
        return _last_battery_info
    _last_battery_at = now
    try:
        battery = psutil.sensors_battery()
        if battery is None:
            _last_battery_info = {"available": False, "percent": None, "plugged": None, "secondsLeft": None}
            return _last_battery_info
        seconds_left = battery.secsleft
        if seconds_left in (psutil.POWER_TIME_UNLIMITED, psutil.POWER_TIME_UNKNOWN):
            seconds_left = None
        _last_battery_info = {
            "available": True,
            "percent": round(float(battery.percent), 1),
            "plugged": bool(battery.power_plugged),
            "secondsLeft": int(seconds_left) if seconds_left is not None else None,
        }
        return _last_battery_info
    except Exception:
        _last_battery_info = {"available": False, "percent": None, "plugged": None, "secondsLeft": None}
        return _last_battery_info


_last_bluetooth_info: Any = None
_last_bluetooth_at = 0.0


def read_bluetooth() -> dict[str, Any]:
    """Paired Bluetooth devices (PnP class) + radio service state.

    Listing only: Windows reserves silent pairing to the Settings UI, so
    "connect" for audio devices routes output to them and everything else
    opens the Bluetooth settings page."""
    global _last_bluetooth_info, _last_bluetooth_at
    now = time.monotonic()
    if _last_bluetooth_info is not None and now - _last_bluetooth_at < 5.0:
        return _last_bluetooth_info
    _last_bluetooth_at = now
    devices: list[dict[str, Any]] = []
    services: dict[str, Any] = {}
    powered = False
    try:
        for name in ("bthserv", "BTAGService", "BluetoothUserService"):
            try:
                status = psutil.win_service_get(name).status()
            except Exception:
                status = "unknown"
            services[name] = str(status)
        powered = str(services.get("bthserv", "")).lower() == "running"
        raw = run_hidden(["powershell", "-NoProfile", "-Command",
            "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | "
            "Select-Object -First 24 Name,Status,FriendlyName,InstanceId | "
            "ConvertTo-Json -Compress"], timeout=4.0)
        if raw:
            parsed = json.loads(raw)
            entries = parsed if isinstance(parsed, list) else [parsed]
            seen: set[str] = set()
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("Name") or entry.get("FriendlyName") or "").strip()
                if not name:
                    continue
                lowered = name.lower()
                # Skip the adapter / generic radio entries PnP loves to
                # report ("Bluetooth", "Microsoft Bluetooth LE", ...) as
                # well as profile transports ("X Avrcp Transport") —
                # those are profiles of an already-listed device.
                if lowered.startswith((
                    "bluetooth",
                    "generic bluetooth",
                    "microsoft bluetooth",
                    "bluetooth ",
                )):
                    continue
                if "transport" in lowered or lowered.endswith(" avrcp"):
                    continue
                norm = "".join(ch for ch in lowered if ch.isalnum())
                if norm in seen:
                    continue
                seen.add(norm)
                paired = str(entry.get("Status") or "").lower() == "ok"
                devices.append({
                    "name": name[:64],
                    "instanceId": str(entry.get("InstanceId") or "")[:128],
                    "paired": bool(paired),
                    "audio": any(k in lowered for k in (
                        "headset", "headphone", "headphones", "earbud",
                        "earbuds", "speaker", "audio", "buds", "sound",
                        "airpod", "dopes", "rockerz", "avrcp", "headset",
                    )),
                })
    except Exception:
        pass
    _last_bluetooth_info = {
        "available": powered or bool(devices),
        "powered": powered,
        "devices": devices,
        "services": services,
    }
    return _last_bluetooth_info


_last_wifi_detail: Any = None
_last_wifi_detail_at = 0.0


def read_wifi_detail() -> dict[str, Any]:
    """SSID, signal, link rate and channel from netsh (no admin needed)."""
    global _last_wifi_detail, _last_wifi_detail_at
    now = time.monotonic()
    if _last_wifi_detail is not None and now - _last_wifi_detail_at < 6.0:
        return _last_wifi_detail
    _last_wifi_detail_at = now
    detail: dict[str, Any] = {
        "ssid": "", "signal": None, "rate": None, "channel": None, "auth": "",
    }
    try:
        raw = run_hidden(["netsh", "wlan", "show", "interfaces"], timeout=3.0)
        for line in raw.splitlines():
            if ":" not in line:
                continue
            key, _, value = line.partition(":")
            key = key.strip().lower()
            value = value.strip()
            if key == "ssid":
                detail["ssid"] = value
            elif key == "signal":
                digits = "".join(ch for ch in value if ch.isdigit())
                detail["signal"] = int(digits) if digits else None
            elif key == "receive rate (mbps)":
                digits = "".join(ch for ch in value if ch.isdigit() or ch == ".")
                try:
                    detail["rate"] = float(digits) if digits else None
                except ValueError:
                    detail["rate"] = None
            elif key == "channel":
                digits = "".join(ch for ch in value if ch.isdigit())
                detail["channel"] = int(digits) if digits else None
            elif key == "authentication":
                detail["auth"] = value
    except Exception:
        pass
    _last_wifi_detail = detail
    return detail


_last_brightness: Any = None
_last_brightness_at = 0.0


def read_brightness() -> dict[str, Any]:
    """Laptop display brightness via WMI (unsupported on most desktops).
    Cached: spawning PowerShell every poll would make the whole island
    stutter, and brightness does not move at 1-second granularity."""
    global _last_brightness, _last_brightness_at
    now = time.monotonic()
    if _last_brightness is not None and now - _last_brightness_at < 5.0:
        return _last_brightness
    _last_brightness_at = now
    try:
        raw = run_hidden(
            ["powershell", "-NoProfile", "-Command",
             "(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightness -ErrorAction Stop).CurrentBrightness"],
            timeout=3.0,
        )
        level = int(str(raw).strip())
        _last_brightness = {"supported": True, "level": max(0, min(100, level))}
    except Exception:
        _last_brightness = {"supported": False, "level": None}
    return _last_brightness


def set_brightness(level: int) -> bool:
    level = max(0, min(100, int(level)))
    try:
        run_hidden(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-WmiObject -Namespace root/wmi -Class WmiMonitorBrightnessMethods -ErrorAction Stop).WmiSetBrightness(1, {level})"],
            timeout=3.0,
        )
        return True
    except Exception:
        return False


_last_top_processes: Any = None
_last_top_processes_at = 0.0


def read_top_processes() -> list[dict[str, Any]]:
    global _last_top_processes, _last_top_processes_at
    now = time.monotonic()
    if _last_top_processes is not None and now - _last_top_processes_at < 5.0:
        return _last_top_processes
    _last_top_processes_at = now
    try:
        entries: list[tuple[float, str]] = []
        for proc in psutil.process_iter(["name"]):
            try:
                usage = proc.cpu_percent(interval=None) or 0.0
                if usage > 0:
                    entries.append((float(usage), str(proc.info.get("name") or "unknown")))
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        entries.sort(reverse=True)
        _last_top_processes = [
            {"name": name[:28], "cpu": round(usage, 1)} for usage, name in entries[:3]
        ]
    except Exception:
        _last_top_processes = []
    return _last_top_processes


_last_theme: Any = None
_last_theme_at = 0.0


def _hsl_to_hex(hue: float, sat: float, light: float) -> str:
    import colorsys

    r, g, b = colorsys.hls_to_rgb((hue % 360.0) / 360.0, light, sat)
    return "#%02X%02X%02X" % (
        max(0, min(255, round(r * 255))),
        max(0, min(255, round(g * 255))),
        max(0, min(255, round(b * 255))),
    )


def _sample_wallpaper_rgb(path: str):
    """Average of colorful pixels of the desktop wallpaper, or None."""
    try:
        from PIL import Image

        with Image.open(path) as img:
            img = img.convert("RGB").resize((48, 48))
            pixels = list(img.getdata())
        sr = sg = sb = n = 0
        for r, g, b in pixels:
            if max(r, g, b) - min(r, g, b) > 18:
                sr += r
                sg += g
                sb += b
                n += 1
        if n < 10:
            return None
        return (sr // n, sg // n, sb // n)
    except Exception:
        return None


def _sample_wallpaper_rgb_bytes(data: bytes):
    """Same sampling for the binary TranscodedWallpaper blob."""
    try:
        from PIL import Image
        import io

        with Image.open(io.BytesIO(data)) as img:
            img = img.convert("RGB").resize((48, 48))
            pixels = list(img.getdata())
        sr = sg = sb = n = 0
        for r, g, b in pixels:
            if max(r, g, b) - min(r, g, b) > 18:
                sr += r
                sg += g
                sb += b
                n += 1
        if n < 10:
            return None
        return (sr // n, sg // n, sb // n)
    except Exception:
        return None


_last_wallpaper_accent: Any = None
_last_wallpaper_accent_at = 0.0


def read_wallpaper_accent() -> dict[str, Any]:
    """Accent palette for the island.

    Preference order: the accent the user picked in Settings (Windows
    AccentColor), then a dominant-hue sample of the wallpaper image,
    then the island's default violet."""
    global _last_wallpaper_accent, _last_wallpaper_accent_at
    now = time.monotonic()
    if _last_wallpaper_accent is not None and now - _last_wallpaper_accent_at < 15.0:
        return _last_wallpaper_accent
    _last_wallpaper_accent_at = now

    accent_rgb = None
    wallpaper_path = ""
    wallpaper_blob = None
    try:
        import winreg

        try:
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Accent"
            )
            try:
                value, _ = winreg.QueryValueEx(key, "AccentColor")
                value = int(value) & 0xFFFFFFFF
                # Default system blue (0x0078D4) means "not customized".
                if value not in (0, 0xFF0078D4):
                    accent_rgb = ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
            finally:
                winreg.CloseKey(key)
        except FileNotFoundError:
            pass

        try:
            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Control Panel\Desktop")
            try:
                wallpaper_path, _ = winreg.QueryValueEx(key, "Wallpaper")
            finally:
                winreg.CloseKey(key)
        except FileNotFoundError:
            pass

        # Modern Windows stores the current wallpaper as a transcoded JPEG.
        try:
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers",
            )
            try:
                blob, _ = winreg.QueryValueEx(key, "TranscodedWallpaper")
                if isinstance(blob, (bytes, bytearray)) and len(blob) > 1024:
                    wallpaper_blob = bytes(blob)
            finally:
                winreg.CloseKey(key)
        except FileNotFoundError:
            pass
    except Exception:
        accent_rgb = None
        wallpaper_path = ""
        wallpaper_blob = None

    if accent_rgb is None and wallpaper_path:
        accent_rgb = _sample_wallpaper_rgb(str(wallpaper_path))
    if accent_rgb is None and wallpaper_blob:
        accent_rgb = _sample_wallpaper_rgb_bytes(wallpaper_blob)

    if accent_rgb is not None:
        import colorsys

        r, g, b = (v / 255.0 for v in accent_rgb)
        hue, _light, _sat = colorsys.rgb_to_hls(r, g, b)
        result = {
            "primary": "#%02X%02X%02X" % accent_rgb,
            "secondary": _hsl_to_hex(hue * 360.0 + 35.0, 0.78, 0.58),
        }
    else:
        result = {"primary": "#A855F7", "secondary": "#22D3EE"}
    _last_wallpaper_accent = result
    return result


def read_theme() -> dict[str, Any]:
    """Windows' own light/dark preference. The island follows it."""
    global _last_theme, _last_theme_at
    now = time.monotonic()
    if _last_theme is not None and now - _last_theme_at < 10.0:
        return _last_theme
    _last_theme_at = now
    light = False
    try:
        import winreg

        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
        )
        try:
            value, _ = winreg.QueryValueEx(key, "AppsUseLightTheme")
            light = int(value) == 1
        finally:
            winreg.CloseKey(key)
    except Exception:
        light = False
    _last_theme = {"light": light}
    return _last_theme


def read_fullscreen() -> bool:
    """True when the foreground window covers the whole monitor."""
    if ctypes is None:
        return False
    try:
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return False
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return False
        monitor = user32.MonitorFromWindow(hwnd, 2)
        info = wintypes.MONITORINFO()
        info.cbSize = ctypes.sizeof(info)
        if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
            return False
        area = info.rcMonitor
        return (
            rect.left <= area.left
            and rect.top <= area.top
            and rect.right >= area.right
            and rect.bottom >= area.bottom
        )
    except Exception:
        return False


def sample_stats() -> dict[str, Any]:
    global _last_net, _last_net_at, _cpu_reported
    now = time.monotonic()
    cpu = psutil.cpu_percent(interval=None)
    if not _cpu_reported:
        cpu = 0.0
        _cpu_reported = True
    try:
        cores_usage = [
            round(max(0.0, min(100.0, float(value))), 1)
            for value in psutil.cpu_percent(interval=None, percpu=True)
        ]
    except Exception:
        cores_usage = []
    memory = psutil.virtual_memory()
    uptime = max(0, int(time.time() - psutil.boot_time()))

    try:
        net = psutil.net_io_counters()
        if _last_net is None:
            up_rate = 0.0
            down_rate = 0.0
        else:
            elapsed = max(0.001, now - _last_net_at)
            up_rate = max(0.0, (net.bytes_sent - _last_net.bytes_sent) / elapsed)
            down_rate = max(0.0, (net.bytes_recv - _last_net.bytes_recv) / elapsed)
        _last_net = net
        _last_net_at = now
    except Exception:
        up_rate = down_rate = 0.0

    update_gpu()
    net_info = read_wifi()
    battery = read_battery()
    power_mode = read_power_mode()
    privacy = read_privacy()
    webcam = privacy["webcam"]
    microphone = privacy["microphone"]
    location = privacy["location"]
    biometrics = read_biometrics()
    theme = read_theme()
    wallpaper_accent = read_wallpaper_accent()

    return {
        "cpu": round(max(0.0, min(100.0, cpu)), 1),
        "cores": psutil.cpu_count(logical=True) or 0,
        "coresUsage": cores_usage,
        "memory": round(max(0.0, min(100.0, memory.percent)), 1),
        "memoryUsed": int(memory.used),
        "memoryTotal": int(memory.total),
        "uptime": uptime,
        "gpu": dict(_gpu_info),
        "network": {
            "up": round(up_rate, 1),
            "down": round(down_rate, 1),
            "ssid": net_info.get("ssid", ""),
            "type": net_info.get("type", ""),
        },
        "battery": battery,
        "powerMode": power_mode,
        "biometrics": biometrics,
        "theme": theme,
        "wallpaperAccent": wallpaper_accent,
        "privacy": {
            "webcam": webcam,
            "microphone": microphone,
            "location": location,
        },
        "bluetooth": read_bluetooth(),
        "wifiDetail": read_wifi_detail(),
        "brightness": read_brightness(),
        "fullscreen": read_fullscreen(),
        "topProcesses": read_top_processes(),
        "processCount": len(psutil.pids()),
    }


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
            continue
        if isinstance(command, dict):
            _command_queue.put(command)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    emit({"type": "ready", "service": "system", "version": 1, "pid": os.getpid()})
    threading.Thread(target=command_reader, name="system-commands", daemon=True).start()
    psutil.cpu_percent(interval=None)
    while _running:
        while not _command_queue.empty():
            try:
                command = _command_queue.get_nowait()
                kind = command.get("type")
                if kind == "refresh":
                    emit(
                        {
                            "type": "system-state",
                            "ts": int(time.time() * 1000),
                            "stats": sample_stats(),
                        }
                    )
                elif kind == "brightness":
                    ok = set_brightness(int(command.get("value", 0) or 0))
                    if command.get("id") is not None:
                        emit({"type": "ack", "id": command["id"], "ok": bool(ok)})
                if command.get("id") is not None:
                    emit({"type": "ack", "id": command["id"], "ok": True})
            except queue.Empty:
                break
        try:
            emit(
                {
                    "type": "system-state",
                    "ts": int(time.time() * 1000),
                    "stats": sample_stats(),
                }
            )
        except Exception as exc:
            log(f"SYSTEM_ERROR: {exc}")
            emit(
                {
                    "type": "system-state",
                    "ts": int(time.time() * 1000),
                    "stats": {},
                    "error": str(exc),
                }
            )
        time.sleep(POLL_SECONDS)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
