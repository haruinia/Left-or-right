from __future__ import annotations

import argparse
import ctypes
import json
import re
import sys


class Win32API:
    def __init__(self):
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
        handle, boolean, dword = ctypes.c_void_p, ctypes.c_int32, ctypes.c_uint32
        self.enum_callback = ctypes.WINFUNCTYPE(boolean, handle, ctypes.c_ssize_t)
        signatures = {
            "EnumWindows": ([self.enum_callback, ctypes.c_ssize_t], boolean),
            "GetClassNameW": ([handle, ctypes.c_wchar_p, ctypes.c_int32], ctypes.c_int32),
            "IsWindow": ([handle], boolean),
            "GetWindowThreadProcessId": ([handle, ctypes.POINTER(dword)], dword),
            "IsWindowVisible": ([handle], boolean),
            "GetWindowDisplayAffinity": ([handle, ctypes.POINTER(dword)], boolean),
            "GetProcessWindowStation": ([], handle),
            "GetUserObjectInformationW": ([handle, ctypes.c_int32, handle, dword, ctypes.POINTER(dword)], boolean),
            "OpenInputDesktop": ([dword, boolean, dword], handle),
            "CloseDesktop": ([handle], boolean),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.user32, name)
            function.argtypes, function.restype = arguments, result
        self.dwmapi.DwmIsCompositionEnabled.argtypes = [ctypes.POINTER(boolean)]
        self.dwmapi.DwmIsCompositionEnabled.restype = ctypes.c_int32

    def environment(self):
        version = sys.getwindowsversion()
        enabled = ctypes.c_int32()
        hresult = self.dwmapi.DwmIsCompositionEnabled(ctypes.byref(enabled))

        class UserObjectFlags(ctypes.Structure):
            _fields_ = [("inherit", ctypes.c_int32), ("reserved", ctypes.c_int32), ("flags", ctypes.c_uint32)]

        flags, length = UserObjectFlags(), ctypes.c_uint32()
        ctypes.set_last_error(0)
        station = self.user32.GetProcessWindowStation()
        station_ok = bool(station) and bool(self.user32.GetUserObjectInformationW(
            station, 1, ctypes.byref(flags), ctypes.sizeof(flags), ctypes.byref(length)
        ))
        station_error = 0 if station_ok else ctypes.get_last_error()
        ctypes.set_last_error(0)
        desktop = self.user32.OpenInputDesktop(0, False, 0x0001)
        desktop_error = 0 if desktop else ctypes.get_last_error()
        close_ok, close_error = None, None
        if desktop:
            ctypes.set_last_error(0)
            close_ok = bool(self.user32.CloseDesktop(desktop))
            close_error = 0 if close_ok else ctypes.get_last_error()
        return {
            "os_major": version.major, "os_minor": version.minor, "os_build": version.build,
            "capture_exclusion_supported": version.build >= 19041,
            "dwm_query_ok": hresult == 0,
            "dwm_enabled": bool(enabled.value) if hresult == 0 else None,
            "dwm_error": hresult & 0xFFFFFFFF,
            "station_query_ok": station_ok,
            "station_visible": bool(flags.flags & 1) if station_ok else None,
            "station_error": station_error,
            "input_desktop_accessible": bool(desktop), "input_desktop_error": desktop_error,
            "input_desktop_closed": close_ok, "input_desktop_close_error": close_error,
        }

    def is_window(self, hwnd):
        return bool(self.user32.IsWindow(hwnd))

    def window_pid(self, hwnd):
        owner = ctypes.c_uint32()
        ctypes.set_last_error(0)
        thread = self.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        return (owner.value, 0) if thread else (None, ctypes.get_last_error())

    def window_visible(self, hwnd):
        return bool(self.user32.IsWindowVisible(hwnd))

    def window_affinity(self, hwnd):
        affinity = ctypes.c_uint32()
        ctypes.set_last_error(0)
        ok = bool(self.user32.GetWindowDisplayAffinity(hwnd, ctypes.byref(affinity)))
        return ok, affinity.value if ok else None, 0 if ok else ctypes.get_last_error()

    def owned_windows(self, pid):
        windows = []

        @self.enum_callback
        def visit(hwnd, _parameter):
            owner, _error = self.window_pid(hwnd)
            if owner == pid:
                name = ctypes.create_unicode_buffer(512)
                ctypes.set_last_error(0)
                length = self.user32.GetClassNameW(hwnd, name, len(name))
                error = 0 if length else ctypes.get_last_error()
                windows.append({"hwnd": str(hwnd), "visible": self.window_visible(hwnd),
                                "class_name": name.value if length else None,
                                "class_query_ok": bool(length), "class_query_error": error})
            return True

        ctypes.set_last_error(0)
        ok = bool(self.user32.EnumWindows(visit, 0))
        return ok, windows, 0 if ok else ctypes.get_last_error()


def run_probe(api, pid=None, hwnds=()):
    environment = api.environment()
    reasons = []
    requirements = {
        "capture_exclusion_supported": "capture_exclusion_not_supported",
        "dwm_query_ok": "dwm_query_failed",
        "dwm_enabled": "dwm_unavailable",
        "station_query_ok": "window_station_query_failed",
        "station_visible": "window_station_not_visible",
        "input_desktop_accessible": "input_desktop_unavailable",
    }
    for field, reason in requirements.items():
        if not environment.get(field):
            reasons.append(reason)
    if environment.get("input_desktop_accessible") and not environment.get("input_desktop_closed"):
        reasons.append("input_desktop_close_failed")
    environment["interactive"] = bool(environment.get("station_visible") and environment.get("input_desktop_accessible"))
    windows = []
    for raw in hwnds:
        hwnd = int(raw)
        result = {"hwnd": raw, "valid": api.is_window(hwnd), "owned": False,
                  "owner_pid": None, "visible": None, "affinity": None,
                  "affinity_query_ok": False, "affinity_error": None}
        if not result["valid"]:
            result["reason"] = "invalid_window"
        else:
            owner, error = api.window_pid(hwnd)
            result["owner_pid"] = owner
            result["owner_query_error"] = error
            if owner != pid:
                result["reason"] = "owner_query_failed" if owner is None else "unexpected_window_owner"
            else:
                result["owned"] = True
                result["visible"] = api.window_visible(hwnd)
                ok, affinity, error = api.window_affinity(hwnd)
                result.update(affinity_query_ok=ok, affinity=affinity, affinity_error=error)
                if not ok:
                    result["reason"] = "affinity_query_failed"
        if result.get("reason"):
            reasons.append(result["reason"])
        windows.append(result)
    owned_ok, owned_windows, owned_error = None, [], None
    if pid is not None:
        owned_ok, owned_windows, owned_error = api.owned_windows(pid)
        if not owned_ok:
            reasons.append("owned_windows_enumeration_failed")
        if any(not window["class_query_ok"] for window in owned_windows):
            reasons.append("owned_window_class_query_failed")
    return {"status": "inconclusive" if reasons else "observed", "platform": "win32",
            "environment": environment, "windows": windows, "owned_windows": owned_windows,
            "owned_windows_query_ok": owned_ok, "owned_windows_error": owned_error,
            "reasons": list(dict.fromkeys(reasons))}, 2 if reasons else 0


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def main(argv=None, *, platform=None, api_factory=Win32API):
    parser = Parser(description="Read-only Windows desktop, HWND visibility and display-affinity probe.")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--hwnds", help="JSON array of decimal HWND strings owned by --pid")
    try:
        args = parser.parse_args(argv)
        if args.preflight:
            if args.pid is not None or args.hwnds is not None:
                raise ValueError("--preflight cannot be combined with --pid or --hwnds")
            hwnds = []
        else:
            if args.pid is None or not 0 < args.pid <= 0xFFFFFFFF or args.hwnds is None:
                raise ValueError("Specify --preflight, or both a positive --pid and --hwnds")
            hwnds = json.loads(args.hwnds)
            maximum = (1 << (ctypes.sizeof(ctypes.c_void_p) * 8)) - 1
            if not isinstance(hwnds, list) or not 1 <= len(hwnds) <= 256 or any(
                not isinstance(hwnd, str) or not re.fullmatch(r"[0-9]{1,20}", hwnd)
                or not 0 < int(hwnd) <= maximum for hwnd in hwnds
            ):
                raise ValueError("--hwnds must contain 1–256 nonzero decimal HWND strings fitting a native pointer")
        current_platform = sys.platform if platform is None else platform
        if current_platform != "win32":
            print(json.dumps({"status": "inconclusive", "platform": current_platform, "reasons": ["windows_required"], "windows": []}))
            return 2
        report, code = run_probe(api_factory(), args.pid, hwnds)
    except (ValueError, OSError, AttributeError) as error:
        report, code = {"status": "inconclusive", "reasons": ["probe_error"], "detail": str(error), "windows": []}, 2
    print(json.dumps(report, sort_keys=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
