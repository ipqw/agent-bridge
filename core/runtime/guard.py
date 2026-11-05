#!/usr/bin/env python3.12
"""Agent Bridge: guard for agent scripts (office pool).

Two entry points, stdlib only, Python 3.12, meant to run as `python -I -B -X utf8 guard.py ...`.

  guard.py check <script.py>            -- AST pre-flight, one JSON line on stdout, exit 0
  guard.py run <policy.json> <script.py> -- re-check, then run <script.py> as __main__ under an
                                            sys.addaudithook deny-by-default boundary

Граница пула (D3). Пул страхует от ошибок агента, не от взломанного агента. По документации Python
(PEP 578) и пробам 20.10 audit hook и AST — не граница против вредоносного кода: C-библиотека может
писать файл, не вызывая событий сторожа (проба: XSLT в lxml записал файл мимо hook). Поэтому `lxml` и
`pypdfium2` убраны из прямых импортов скриптов, а дыры, найденные пробами (удаление/переименование,
XSLT, `__builtins__[...]`, `().__class__`), закрыты списками ниже. Класс «C-библиотека пишет мимо
сторожа» — принятый риск; барьер записи на уровне ОС (Windows Low integrity) — TODO.
gstack-shortcut(dec-bdfd3daa)
"""

from __future__ import annotations

import ast
import io
import json
import os
import string
import sys
import threading
import traceback

# --- AST rules -------------------------------------------------------------

# Top-level modules a script may import. lxml / pypdfium2 are deliberately absent:
# they write files past the audit hook (C level), so scripts get them only via office_ops.
ALLOWED_IMPORTS = frozenset({
    "openpyxl", "docx", "pptx", "defusedxml", "pandas", "numpy", "markitdown", "pypdf",
    "PIL", "reportlab", "json", "re", "math", "statistics", "datetime", "decimal",
    "fractions", "collections", "itertools", "functools", "copy", "string", "textwrap",
    "csv", "io", "zipfile", "pathlib", "typing", "dataclasses", "enum", "unicodedata",
    "base64", "hashlib",
})

# Names that must never appear (dynamic code, attribute/namespace reach-through, stdin).
FORBIDDEN_NAMES = frozenset({
    "eval", "exec", "compile", "__import__", "getattr", "setattr", "delattr",
    "globals", "locals", "vars", "breakpoint", "input",
})

# Call/attribute targets that read or write past the guard (pandas/lxml escape hatches).
FORBIDDEN_CALLS = frozenset({
    "read_xml", "to_xml", "read_pickle", "read_html", "to_clipboard", "read_clipboard", "XSLT",
})

NET_IMPORTS = frozenset({"socket", "urllib", "http", "ftplib", "requests", "webbrowser", "asyncio"})
PROC_IMPORTS = frozenset({"subprocess", "os", "multiprocessing", "sys", "ctypes", "signal"})


def _import_reason(top: str) -> str:
    if top in NET_IMPORTS:
        return "хочет выйти в интернет"
    if top in {"subprocess", "multiprocessing"} or top == "os":
        return "хочет запустить программу"
    return "хочет работать с системой напрямую"


def _format_fields_touch_underscore(s: str) -> bool:
    # str.format / format_map can reach a dunder via the format string itself, invisible to the
    # normal attribute rule: "{0.__class__}".format(x). Flag any field whose attribute/index path
    # names an underscore member.
    try:
        for _lit, field, _spec, _conv in string.Formatter().parse(s):
            if not field:
                continue
            # field like "0.__class__" or "a[__x]" -> split on . and [
            for part in field.replace("[", ".").replace("]", ".").split("."):
                if part.startswith("_"):
                    return True
    except (ValueError, IndexError):
        return False
    return False


def check_source(source: str, filename: str) -> list[dict]:
    """Return a list of problems (empty == clean). Each: {line, kind, detail, reason}."""
    try:
        tree = ast.parse(source, filename=filename)
    except SyntaxError as e:
        return [{
            "line": e.lineno or 0,
            "kind": "syntax",
            "detail": (e.msg or "syntax error"),
            "reason": "в скрипте синтаксическая ошибка",
        }]

    problems: list[dict] = []
    seen: set[tuple] = set()

    def add(line: int, kind: str, detail: str, reason: str) -> None:
        key = (line, kind, detail)
        if key in seen:
            return
        seen.add(key)
        problems.append({"line": line, "kind": kind, "detail": detail, "reason": reason})

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                if top not in ALLOWED_IMPORTS:
                    add(node.lineno, "import", f"import {alias.name}", _import_reason(top))
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                # relative import in a standalone script -> reach outside the file
                add(node.lineno, "import", f"from {'.' * node.level}{node.module or ''} import ...",
                    "использует запрещённую конструкцию Python")
                continue
            top = (node.module or "").split(".")[0]
            if top not in ALLOWED_IMPORTS:
                add(node.lineno, "import", f"from {node.module} import ...", _import_reason(top))
        elif isinstance(node, ast.Name):
            nid = node.id
            if nid in FORBIDDEN_CALLS:
                add(node.lineno, "call", nid, "использует запрещённую операцию с данными")
            elif nid in FORBIDDEN_NAMES or nid.startswith("_"):
                add(node.lineno, "name", nid, "использует запрещённую конструкцию Python")
        elif isinstance(node, ast.Attribute):
            attr = node.attr
            if attr in FORBIDDEN_CALLS:
                add(node.lineno, "call", attr, "использует запрещённую операцию с данными")
            elif attr.startswith("_"):
                add(node.lineno, "attr", f".{attr}", "использует запрещённую конструкцию Python")
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if _format_fields_touch_underscore(node.value):
                add(node.lineno, "attr", "format-строка с _-атрибутом",
                    "использует запрещённую конструкцию Python")

    problems.sort(key=lambda p: (p["line"], p["kind"]))
    return problems


# --- runtime boundary ------------------------------------------------------

# Audit events allowed unconditionally. Each is side-effect-free introspection or part of the import
# machinery; a pool script cannot invoke the dangerous ones (eval/exec/compile/__import__ are blocked
# by the AST name rule), so only trusted library/import code reaches them here.
SAFE_EVENTS = frozenset({
    "compile",          # bytecode compile during import; script's own compile() blocked by AST
    "exec",             # exec of module/code objects during import; script's exec()/eval() blocked by AST
    "marshal.loads",    # loading .pyc during import
    "import",           # module import; dynamic import unreachable (no __import__/importlib in pool)
    "builtins.id",      # id(); pure read
    "object.__getattr__",   # attribute access machinery; no I/O
    "object.__setattr__",   # attribute assignment machinery; no I/O
    "object.__delattr__",   # attribute delete machinery; no I/O
    "sys._getframe",            # frame introspection by libs (typing, dataclasses); no I/O
    "sys._getframemodulename",  # same
    "array.__new__",    # array allocation (numpy/stdlib); no I/O
})

# Directory enumeration: read-only, result only returns to the agent (same trust as reading).
READ_ENUM_EVENTS = frozenset({
    "os.listdir", "os.scandir", "os.walk", "os.fwalk",
    "pathlib.Path.glob", "pathlib.Path.rglob", "pathlib.Path.walk",
})

# Metadata / cleanup ops libraries do on their own temp files (openpyxl, pandas). Allowed only
# inside temp_dir; anywhere else these are mutations of client files -> deny.
TEMP_ONLY_EVENTS = frozenset({
    "os.remove", "os.unlink", "os.rmdir", "os.mkdir", "os.utime", "os.truncate",
    "tempfile.mkstemp", "tempfile.mkdtemp",
})

# Prefix -> plain-Russian reason for the deny-by-default path, matched longest-first.
DENY_REASONS = [
    ("subprocess", "хочет запустить программу"),
    ("os.system", "хочет запустить программу"),
    ("os.exec", "хочет запустить программу"),
    ("os.spawn", "хочет запустить программу"),
    ("os.posix_spawn", "хочет запустить программу"),
    ("os.fork", "хочет запустить программу"),
    ("os.startfile", "хочет запустить программу"),
    ("os.add_dll_directory", "хочет обратиться к системе напрямую"),
    ("webbrowser", "хочет запустить программу"),
    ("os.rename", "хочет удалить или переименовать файлы"),
    ("os.replace", "хочет удалить или переименовать файлы"),
    ("os.remove", "хочет удалить или переименовать файлы"),
    ("os.unlink", "хочет удалить или переименовать файлы"),
    ("os.rmdir", "хочет удалить или переименовать файлы"),
    ("os.link", "хочет удалить или переименовать файлы"),
    ("os.symlink", "хочет удалить или переименовать файлы"),
    ("os.truncate", "хочет изменить файл вне разрешённых правок"),
    ("os.utime", "хочет изменить свойства файла"),
    ("os.mkdir", "хочет создать папку вне разрешённого места"),
    ("os.chmod", "хочет изменить свойства файла"),
    ("os.chown", "хочет изменить свойства файла"),
    ("os.chflags", "хочет изменить свойства файла"),
    ("os.putenv", "хочет изменить настройки системы"),
    ("os.unsetenv", "хочет изменить настройки системы"),
    ("os.chdir", "хочет работать с системой напрямую"),
    ("os.kill", "хочет запустить программу"),
    ("socket.", "хочет выйти в интернет"),
    ("urllib.", "хочет выйти в интернет"),
    ("http.", "хочет выйти в интернет"),
    ("ftplib.", "хочет выйти в интернет"),
    ("ctypes", "хочет обратиться к системе напрямую"),
    ("cpython.run", "хочет работать с системой напрямую"),
    ("winreg.", "хочет обратиться к системе напрямую"),
    ("_winapi.", "хочет обратиться к системе напрямую"),
    ("pickle.find_class", "использует запрещённую операцию с данными"),
    ("sys.addaudithook", "хочет обойти проверку"),
    ("sys.settrace", "хочет обойти проверку"),
    ("sys.setprofile", "хочет обойти проверку"),
    ("gc.", "хочет обойти проверку"),
]


def _deny_reason(event: str) -> str:
    for prefix, reason in DENY_REASONS:
        if event == prefix or event.startswith(prefix):
            return reason
    return f"хочет сделать то, что не разрешено ({event})"


# Windows-only events (not observable on Linux/CI here; exercised on windows-latest):
#   - os.startfile          -> launching a file's associated program; deny-by-default (process launch).
#   - winreg.OpenKey / winreg.QueryValue / winreg.* -> registry access; deny-by-default. markitdown's
#     mimetypes.init() reads the registry, so it is warmed BEFORE the hook (see _preimport) — otherwise
#     a normal convert would be denied mid-run.
#   - _winapi.CreateProcess / _winapi.CreateFile / _winapi.* -> deny-by-default (process / handle).
#   - os.add_dll_directory  -> DLL search-path change; deny-by-default (hijack vector).
# All four fall through _dispatch to deny-by-default with a plain-Russian reason from DENY_REASONS.
# A pool script cannot even reach os/winreg/_winapi (their imports are AST-rejected first, exit 98);
# the hook entries are the second layer for the accepted "C-extension reaches them" residual risk (D3).
# Read of %WINDIR%\\Fonts is allowed (PIL/reportlab font lookup) — added to read_roots on Windows.


class Boundary:
    """Deny-by-default audit hook plus the created-files manifest."""

    def __init__(self, policy: dict, script_path: str) -> None:
        self.win = sys.platform == "win32"
        self.temp_dir = self._norm(policy.get("temp_dir") or "")
        self.manifest_path = policy["manifest"]

        # read roots: policy read_roots + interpreter prefixes + script dir + temp_dir + Fonts (win)
        roots = list(policy.get("read_roots") or [])
        roots += [sys.prefix, sys.base_prefix, sys.exec_prefix]
        roots.append(os.path.dirname(os.path.abspath(script_path)))
        if self.temp_dir:
            roots.append(policy.get("temp_dir"))
        if self.win:
            windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
            if windir:
                roots.append(os.path.join(windir, "Fonts"))
        self.read_roots = sorted({self._norm(r) for r in roots if r})

        self.write_files = {self._norm(p) for p in (policy.get("write_files") or [])}
        self.new_file_roots = sorted({self._norm(r) for r in (policy.get("new_file_roots") or [])})

        self.created_keys: set[str] = set()   # normcased keys of files this run created
        self.created_list: list[str] = []      # real paths, outside temp_dir, for the manifest

        self._local = threading.local()        # re-entrancy guard: hook work triggers more events
        self._manifest_fo: io.TextIOBase | None = None

    # -- path helpers (run with the re-entrancy flag set, so nested stat events are ignored) --

    @staticmethod
    def _decode(p) -> str:
        if isinstance(p, bytes):
            return os.fsdecode(p)
        return p

    @staticmethod
    def _norm(p: str) -> str:
        if not p:
            return ""
        return os.path.normcase(os.path.realpath(p))

    def _reject_raw(self, raw: str) -> str | None:
        # Checks on the path as written, before realpath collapses them.
        if raw.startswith("\\\\?\\") or raw.startswith("\\\\.\\"):
            return "запрещённый путь (расширенный/устройство)"
        if raw.startswith("\\\\") or (self.win and raw.startswith("//")):
            return "запрещённый путь (сетевой ресурс UNC)"
        if self.win:
            _drive, rest = os.path.splitdrive(raw)
            if ":" in rest:
                return "запрещённый путь (альтернативный поток данных)"
        return None

    def _within(self, key: str, root: str) -> bool:
        if not root or not key:
            return False
        if key == root:
            return True
        try:
            return os.path.commonpath([key, root]) == root
        except ValueError:
            return False

    def _in_any(self, key: str, roots) -> bool:
        return any(self._within(key, r) for r in roots)

    # -- manifest --

    def open_manifest(self) -> None:
        # Opened BEFORE the hook is installed: later writes go through this fd, raising no `open`
        # event, so the manifest path need not be inside an allowed root.
        self._manifest_fo = open(self.manifest_path, "w", encoding="utf-8")

    def write_manifest(self, denied: dict | None) -> None:
        if self._manifest_fo is None:
            return
        data = {"created": self.created_list, "denied": denied}
        try:
            self._manifest_fo.seek(0)
            self._manifest_fo.truncate()
            self._manifest_fo.write(json.dumps(data, ensure_ascii=False))
            self._manifest_fo.flush()
            os.fsync(self._manifest_fo.fileno())
        except OSError:
            pass

    # -- denial --

    def _deny(self, event: str, detail: str, reason: str) -> None:
        record = {"event": event, "detail": detail, "reason": reason}
        self.write_manifest(record)
        sys.stderr.write("BRIDGE-GUARD-DENIED: " + json.dumps(record, ensure_ascii=False) + "\n")
        sys.stderr.flush()
        os._exit(97)

    # -- the hook --

    def hook(self, event: str, args: tuple) -> None:
        if getattr(self._local, "busy", False):
            return
        self._local.busy = True
        try:
            self._dispatch(event, args)
        finally:
            self._local.busy = False

    def _dispatch(self, event: str, args: tuple) -> None:
        if event in SAFE_EVENTS or event in READ_ENUM_EVENTS:
            return
        if event == "open":
            self._check_open(args)
            return
        if event in TEMP_ONLY_EVENTS:
            self._check_temp_only(event, args)
            return
        # deny-by-default: anything not explicitly allowed above
        detail = ""
        if args:
            try:
                detail = str(self._decode(args[0]))[:200]
            except Exception:
                detail = "<?>"
        self._deny(event, detail, _deny_reason(event))

    def _is_write(self, mode, flags) -> bool:
        if isinstance(mode, str):
            return any(c in mode for c in ("w", "a", "x", "+"))
        if isinstance(flags, int):
            wbits = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
            return bool(flags & wbits)
        return False

    def _check_open(self, args: tuple) -> None:
        path = args[0] if args else None
        if isinstance(path, int):
            return  # already-open fd (e.g. os.fdopen); the owning open was checked
        mode = args[1] if len(args) > 1 else None
        flags = args[2] if len(args) > 2 else None
        raw = self._decode(path)
        bad = self._reject_raw(raw)
        if bad:
            self._deny("open", raw[:200], bad)
        key = self._norm(raw)
        real = os.path.realpath(raw)
        if self._is_write(mode, flags):
            if self._allow_write(key, real):
                return
            self._deny("open", real[:200], "хочет изменить файл вне разрешённых правок")
        else:
            if self._allow_read(key):
                return
            self._deny("open", real[:200], "хочет прочитать файл вне разрешённых папок")

    def _allow_write(self, key: str, real: str) -> bool:
        if self._within(key, self.temp_dir):
            return True                         # run temp: read+write, not in the manifest
        if key in self.write_files:
            return True                         # a registered copy / agent file
        if key in self.created_keys:
            return True                         # created earlier in this run
        if not os.path.lexists(real) and self._in_any(key, self.new_file_roots):
            self.created_keys.add(key)          # a brand-new file inside an allowed folder
            self.created_list.append(real)
            return True
        return False

    def _allow_read(self, key: str) -> bool:
        if self._in_any(key, self.read_roots):
            return True
        if key in self.write_files or key in self.created_keys:
            return True                         # may read its own copies / created files
        return False

    def _check_temp_only(self, event: str, args: tuple) -> None:
        target = args[0] if args else None
        if isinstance(target, int):
            return
        raw = self._decode(target)
        bad = self._reject_raw(raw)
        if bad:
            self._deny(event, raw[:200], bad)
        key = self._norm(raw)
        if self._within(key, self.temp_dir):
            return
        self._deny(event, os.path.realpath(raw)[:200], _deny_reason(event))


# --- entry points ----------------------------------------------------------

def _read_source(path: str) -> str:
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def cmd_check(script_path: str) -> int:
    source = _read_source(script_path)
    problems = check_source(source, script_path)
    if problems:
        sys.stdout.write(json.dumps({"ok": False, "problems": problems}, ensure_ascii=False) + "\n")
    else:
        sys.stdout.write(json.dumps({"ok": True}) + "\n")
    return 0


def _preimport(source: str, script_path: str) -> None:
    # Import the allowed modules the script imports BEFORE the hook: library import side effects
    # (loading C extensions, reading package data) happen outside the boundary. Warm lazy inits
    # too (mimetypes reads the registry on Windows via markitdown).
    import importlib
    try:
        tree = ast.parse(source, filename=script_path)
    except SyntaxError:
        return
    # Import the full dotted module paths (not just the top level) so a library's import-time file
    # reads — e.g. reportlab reading ~/.reportlab_settings — happen before the boundary is active.
    wanted: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in ALLOWED_IMPORTS:
                    wanted.add(alias.name)
        elif isinstance(node, ast.ImportFrom) and not (node.level and node.level > 0):
            module = node.module or ""
            if module.split(".")[0] in ALLOWED_IMPORTS:
                wanted.add(module)
                for alias in node.names:  # `from pkg import sub` -> try pkg.sub as a submodule too
                    wanted.add(module + "." + alias.name)
    for name in sorted(wanted):
        try:
            importlib.import_module(name)
        except Exception:
            pass  # a real import error surfaces when the script itself imports it, with a clean traceback
    try:
        import mimetypes
        mimetypes.init()
    except Exception:
        pass


def cmd_run(policy_path: str, script_path: str) -> int:
    source = _read_source(script_path)

    # 1. re-run the AST check; a script that changed since `check` is rejected hard
    problems = check_source(source, script_path)
    if problems:
        sys.stderr.write("BRIDGE-GUARD-REJECTED: "
                         + json.dumps({"ok": False, "problems": problems}, ensure_ascii=False) + "\n")
        sys.stderr.flush()
        return 98

    with open(policy_path, "r", encoding="utf-8") as f:
        policy = json.load(f)

    # 2. keep library temp files inside the run temp dir, so their open/remove land in an allowed place
    temp_dir = policy.get("temp_dir")
    if temp_dir:
        import tempfile
        tempfile.tempdir = temp_dir
        for var in ("TMPDIR", "TEMP", "TMP"):
            os.environ[var] = temp_dir

    sys.dont_write_bytecode = True  # no .pyc writes (also implied by -B)

    # 3. import side effects before the hook
    _preimport(source, script_path)

    boundary = Boundary(policy, script_path)
    boundary.open_manifest()  # before the hook: writes go through this fd, no `open` event

    code = compile(source, script_path, "exec")
    globs = {"__name__": "__main__", "__file__": script_path, "__builtins__": __builtins__}
    sys.argv = [script_path]

    # 4. install the boundary and run as __main__
    sys.addaudithook(boundary.hook)
    try:
        exec(code, globs)
    except SystemExit as e:
        boundary.write_manifest(None)
        return int(e.code) if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:
        traceback.print_exc()
        boundary.write_manifest(None)
        return 1
    boundary.write_manifest(None)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "check":
        return cmd_check(argv[2])
    if len(argv) >= 4 and argv[1] == "run":
        return cmd_run(argv[2], argv[3])
    sys.stderr.write("usage: guard.py check <script.py> | run <policy.json> <script.py>\n")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
