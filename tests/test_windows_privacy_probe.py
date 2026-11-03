import ctypes
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location("windows_privacy_probe", Path(__file__).with_name("probe_windows_privacy.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def environment(**changes):
    return {"os_major": 10, "os_minor": 0, "os_build": 26100,
            "capture_exclusion_supported": True, "dwm_query_ok": True, "dwm_enabled": True,
            "dwm_error": 0, "station_query_ok": True, "station_visible": True, "station_error": 0,
            "input_desktop_accessible": True, "input_desktop_error": 0,
            "input_desktop_closed": True, "input_desktop_close_error": 0, **changes}


class FakeAPI:
    def __init__(self, *, env=None, valid=True, owner=42, visible=True, affinity=(True, 17, 0), enumeration=None):
        self.env = environment() if env is None else env
        self.valid, self.owner, self.visible, self.affinity = valid, owner, visible, affinity
        self.enumeration = (True, [], 0) if enumeration is None else enumeration
        self.calls = []

    def environment(self):
        self.calls.append("environment")
        return dict(self.env)

    def is_window(self, hwnd):
        self.calls.append(("valid", hwnd))
        return self.valid

    def window_pid(self, hwnd):
        self.calls.append(("owner", hwnd))
        return self.owner, 0 if self.owner else 1400

    def window_visible(self, hwnd):
        self.calls.append(("visible", hwnd))
        return self.visible

    def window_affinity(self, hwnd):
        self.calls.append(("affinity", hwnd))
        return self.affinity

    def owned_windows(self, pid):
        self.calls.append(("enumerate", pid))
        return self.enumeration


def test_preflight_only_reports_environment_without_enumerating_windows():
    api = FakeAPI()
    report, code = probe.run_probe(api)
    assert code == 0 and report["status"] == "observed"
    assert report["environment"]["interactive"] is True
    assert report["owned_windows"] == [] and report["owned_windows_query_ok"] is None
    assert report["windows"] == [] and api.calls == ["environment"]


@pytest.mark.parametrize(("field", "reason"), [
    ("capture_exclusion_supported", "capture_exclusion_not_supported"),
    ("dwm_query_ok", "dwm_query_failed"),
    ("dwm_enabled", "dwm_unavailable"),
    ("station_query_ok", "window_station_query_failed"),
    ("station_visible", "window_station_not_visible"),
    ("input_desktop_accessible", "input_desktop_unavailable"),
    ("input_desktop_closed", "input_desktop_close_failed"),
])
def test_unavailable_native_capabilities_never_report_pass(field, reason):
    report, code = probe.run_probe(FakeAPI(env=environment(**{field: False})))
    assert code == 2 and report["status"] == "inconclusive"
    assert reason in report["reasons"]


def test_high_hwnd_preserved_and_ownership_checked_before_queries():
    hwnd = (1 << 44) + 123
    api = FakeAPI()
    report, code = probe.run_probe(api, 42, [str(hwnd)])
    assert code == 0
    window = report["windows"][0]
    assert window["hwnd"] == str(hwnd) and window["owned"] and window["visible"]
    assert window["affinity"] == 17 and window["affinity_query_ok"]
    assert api.calls == ["environment", ("valid", hwnd), ("owner", hwnd), ("visible", hwnd), ("affinity", hwnd), ("enumerate", 42)]


@pytest.mark.parametrize(("valid", "owner", "reason"), [
    (False, 42, "invalid_window"), (True, 99, "unexpected_window_owner"), (True, None, "owner_query_failed"),
])
def test_invalid_or_foreign_handles_are_not_queried(valid, owner, reason):
    api = FakeAPI(valid=valid, owner=owner)
    report, code = probe.run_probe(api, 42, ["123"])
    assert code == 2 and reason in report["reasons"]
    assert report["windows"][0]["owned"] is False
    assert not any(isinstance(call, tuple) and call[0] in {"visible", "affinity"} for call in api.calls)


def test_affinity_failure_keeps_error_and_is_not_interpreted_as_zero():
    report, code = probe.run_probe(FakeAPI(affinity=(False, None, 5)), 42, ["123"])
    assert code == 2
    assert report["windows"][0]["affinity"] is None
    assert report["windows"][0]["affinity_error"] == 5
    assert "affinity_query_failed" in report["reasons"]


def test_successful_zero_affinity_and_hidden_window_are_observations_not_protection_claims():
    report, code = probe.run_probe(FakeAPI(visible=False, affinity=(True, 0, 0)), 42, ["123"])
    assert code == 0 and report["status"] == "observed"
    assert report["windows"][0]["visible"] is False
    assert report["windows"][0]["affinity"] == 0


@pytest.mark.parametrize("enumeration, reason", [
    ((False, [], 5), "owned_windows_enumeration_failed"),
    ((True, [{"hwnd": "124", "visible": True, "class_name": None, "class_query_ok": False, "class_query_error": 1400}], 0), "owned_window_class_query_failed"),
])
def test_native_enumeration_failures_are_inconclusive(enumeration, reason):
    report, code = probe.run_probe(FakeAPI(enumeration=enumeration), 42, ["123"])
    assert code == 2 and reason in report["reasons"]


@pytest.mark.parametrize("arguments", [
    [], ["--pid", "42"], ["--pid", "0", "--hwnds", '["123"]'],
    ["--pid", "42", "--hwnds", "not-json"], ["--pid", "42", "--hwnds", "[]"],
    ["--pid", "42", "--hwnds", "[123]"], ["--pid", "42", "--hwnds", '["0"]'],
    ["--pid", "42", "--hwnds", '["18446744073709551616"]'],
    ["--pid", "42", "--hwnds", '["１２３"]'], ["--preflight", "--pid", "42"],
    ["--pid", "invalid", "--hwnds", '["123"]'], ["--unknown"],
])
def test_invalid_cli_arguments_still_emit_json(arguments, capsys):
    assert probe.main(arguments, platform="win32", api_factory=lambda: pytest.fail("Native API must not be loaded")) == 2
    output = capsys.readouterr()
    assert json.loads(output.out)["status"] == "inconclusive"
    assert output.err == ""


def test_non_windows_preflight_does_not_load_windows_libraries(capsys):
    assert probe.main(["--preflight"], platform="darwin", api_factory=lambda: pytest.fail("Unexpected Windows import")) == 2
    assert json.loads(capsys.readouterr().out)["reasons"] == ["windows_required"]


def test_help_is_available_without_windows(capsys):
    with pytest.raises(SystemExit) as stopped:
        probe.main(["--help"], platform="darwin", api_factory=lambda: pytest.fail("Unexpected Windows import"))
    assert stopped.value.code == 0
    assert "--hwnds" in capsys.readouterr().out


def test_cli_valid_call_emits_native_observations(capsys):
    assert probe.main(["--pid", "42", "--hwnds", '["123"]'], platform="win32", api_factory=FakeAPI) == 0
    assert json.loads(capsys.readouterr().out)["windows"][0]["owner_pid"] == 42


def test_win32_handle_signatures_are_pointer_sized(monkeypatch):
    class Function:
        pass
    class Library:
        def __getattr__(self, name):
            function = Function()
            setattr(self, name, function)
            return function
    monkeypatch.setattr(ctypes, "WinDLL", lambda *args, **kwargs: Library(), raising=False)
    monkeypatch.setattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE, raising=False)
    api = probe.Win32API()
    assert api.user32.GetProcessWindowStation.restype is ctypes.c_void_p
    assert api.user32.OpenInputDesktop.restype is ctypes.c_void_p
    for name in ["IsWindow", "GetWindowThreadProcessId", "IsWindowVisible", "GetWindowDisplayAffinity", "CloseDesktop"]:
        assert getattr(api.user32, name).argtypes[0] is ctypes.c_void_p
    assert ctypes.sizeof(api.user32.GetWindowThreadProcessId.argtypes[1]._type_) == 4
    assert api.user32.EnumWindows.argtypes[1] is ctypes.c_ssize_t


@pytest.mark.parametrize("accessible", [True, False])
def test_native_environment_checks_flags_and_closes_only_opened_desktop(monkeypatch, accessible):
    monkeypatch.setattr(ctypes, "set_last_error", lambda value: None, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
    monkeypatch.setattr(probe.sys, "getwindowsversion", lambda: SimpleNamespace(major=10, minor=0, build=19040), raising=False)
    handle = (1 << 44) + 321
    closed = []
    def station_flags(station, information, flags, size, needed):
        assert station == handle and information == 1 and size == 12
        flags._obj.flags = 1
        needed._obj.value = size
        return 1
    def composition(enabled):
        enabled._obj.value = 1
        return 0
    def open_desktop(flags, inherit, access):
        assert (flags, inherit, access) == (0, False, 1)
        return handle if accessible else None
    api = object.__new__(probe.Win32API)
    api.user32 = SimpleNamespace(GetProcessWindowStation=lambda: handle, GetUserObjectInformationW=station_flags,
                                 OpenInputDesktop=open_desktop, CloseDesktop=lambda value: closed.append(value) or 1)
    api.dwmapi = SimpleNamespace(DwmIsCompositionEnabled=composition)
    result = api.environment()
    assert result["os_build"] == 19040 and result["capture_exclusion_supported"] is False
    assert result["dwm_query_ok"] and result["dwm_enabled"] and result["station_visible"]
    assert result["input_desktop_accessible"] is accessible
    assert result["input_desktop_error"] == (0 if accessible else 5)
    assert closed == ([handle] if accessible else [])
    assert result["input_desktop_closed"] is (True if accessible else None)


def test_native_enumeration_filters_pid_before_reading_class_or_visibility(monkeypatch):
    monkeypatch.setattr(ctypes, "set_last_error", lambda value: None, raising=False)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 0, raising=False)
    own, foreign = (1 << 44) + 123, (1 << 44) + 456
    calls = []
    def enumerate_windows(callback, parameter):
        callback(own, parameter)
        callback(foreign, parameter)
        return 1
    def class_name(hwnd, buffer, count):
        calls.append(("class", hwnd))
        assert hwnd == own
        buffer.value = "#32770"
        return len(buffer.value)
    def visible(hwnd):
        calls.append(("visible", hwnd))
        assert hwnd == own
        return 1
    api = object.__new__(probe.Win32API)
    api.enum_callback = lambda function: function
    api.window_pid = lambda hwnd: (42 if hwnd == own else 99, 0)
    api.user32 = SimpleNamespace(EnumWindows=enumerate_windows, GetClassNameW=class_name, IsWindowVisible=visible)
    ok, windows, error = api.owned_windows(42)
    assert ok and error == 0
    assert windows == [{"hwnd": str(own), "visible": True, "class_name": "#32770", "class_query_ok": True, "class_query_error": 0}]
    assert calls == [("class", own), ("visible", own)]
