"""Office document operations for the Agent Bridge (docs/ARCHITECTURE.md, «Офисные файлы»).

Usage: office_ops.py <op> <args.json | inline JSON object>
The last stdout line is the result: {"ok": true, ...} or {"ok": false, "code": "<machine code>", "error": "<Russian>"}.

Ops: detect, read, convert, recalc, render. Backends: Microsoft Office over COM (pywin32) or the bridge's
LibreOffice with its own profile. The bridge runs these one at a time (R13): PowerPoint is a single
instance per system and soffice does not tolerate two processes on one profile.
"""

from __future__ import annotations

import io
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
import zipfile
from contextlib import contextmanager

WIN = sys.platform == "win32"

WORD = {".doc", ".docx", ".docm", ".rtf", ".odt"}
EXCEL = {".xls", ".xlsx", ".xlsm", ".xlsb", ".ods"}
POWERPOINT = {".ppt", ".pptx", ".pptm", ".odp"}
LEGACY_READ = {".doc", ".ppt"}  # markitdown has no converter for them (R10)
TARGET_KIND = {"docx": "word", "xlsx": "excel", "pptx": "powerpoint"}

# LibreOffice export filters (names from filter/source/config/fragments/filters, libreoffice-26.2.6.3)
LO_FILTER = {
    "docx": "docx:MS Word 2007 XML",
    "xlsx": "xlsx:Calc MS Excel 2007 XML",
    "xlsm": "xlsm:Calc MS Excel 2007 VBA XML",
    "pptx": "pptx:Impress MS PowerPoint 2007 XML",
    "pdf": "pdf",
}
LO_TIMEOUT = 240

NO_BACKEND = "пересчёт и просмотр недоступны: на компе нет Microsoft Office, а LibreOffice клиент не установил"


class OpError(Exception):
    def __init__(self, code: str, error: str):
        super().__init__(error)
        self.code = code
        self.error = error


def kind_of(ext: str) -> str | None:
    if ext in WORD:
        return "word"
    if ext in EXCEL:
        return "excel"
    if ext in POWERPOINT:
        return "powerpoint"
    return None


def source(a: dict) -> pathlib.Path:
    p = a.get("path")
    if not isinstance(p, str) or not p:
        raise OpError("bad_args", "не указан путь к файлу")
    src = pathlib.Path(p)
    if not src.is_file():
        raise OpError("not_found", f"файл не найден: {p}")
    return src


def work_dir(a: dict) -> pathlib.Path:
    w = a.get("work_dir")
    if not isinstance(w, str) or not w:
        raise OpError("bad_args", "не указана рабочая папка (work_dir)")
    d = pathlib.Path(w)
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------- Excel 4.0 (XLM) macro sheets: refused before anything opens the book (R7) ----------
# AutomationSecurity=ForceDisable does not cover XLM, so such books never reach Excel or LibreOffice.

OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def has_xlm_macros(path: pathlib.Path) -> bool:
    with open(path, "rb") as f:
        head = f.read(8)
    if head[:4] == b"PK\x03\x04":
        try:
            z = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            return False
        with z:
            for name in z.namelist():
                low = name.lower().lstrip("/")
                if low.startswith(("xl/macrosheets/", "xl/intlmacrosheets/")):
                    return True
            try:
                types = z.read("[Content_Types].xml").lower()
            except KeyError:
                return False
            return b"macrosheet" in types  # .macrosheet+xml, .intlmacrosheet+xml, xlsb .macrosheet
    if head == OLE_MAGIC:
        return biff_macro_sheet(path)
    return False


def biff_macro_sheet(path: pathlib.Path) -> bool:
    """BIFF5/8 workbook globals: BOUNDSHEET (0x0085) with sheet type 1 = Excel 4.0 macro sheet."""
    from xlrd import compdoc

    excel = path.suffix.lower() in EXCEL or path.suffix.lower() in {".xlt", ".xla"}
    try:
        cd = compdoc.CompDoc(path.read_bytes(), logfile=io.StringIO())
        for name in ("Workbook", "Book"):
            mem, base, size = cd.locate_named_stream(name)
            if mem is not None:
                break
        else:
            return False
    except Exception:
        if excel:
            raise OpError("xlm_macros", "не удалось проверить книгу на макросы Excel 4.0 — открывать её мост не будет")
        return False
    pos, end = base, base + size
    while pos + 4 <= end:
        rtype, rlen = struct.unpack_from("<HH", mem, pos)
        body = mem[pos + 4 : pos + 4 + rlen]
        if rtype == 0x0085 and len(body) >= 6 and body[5] == 0x01:
            return True
        if rtype == 0x000A:  # EOF of the globals substream
            break
        pos += 4 + rlen
    return False


def refuse_xlm(path: pathlib.Path) -> None:
    if has_xlm_macros(path):
        raise OpError("xlm_macros", "в книге есть макросы Excel 4.0 (XLM) — открывать и пересчитывать её мост не будет")


# ---------- LibreOffice ----------

# Profile written before every run (п. 6, R7). Keys checked against officecfg/registry/schema of
# libreoffice-26.2.6.3 (Common.xcs, Calc.xcs, Writer.xcs):
#   Common/Security/Scripting/DisableMacrosExecution = true  Basic, BeanShell, JavaScript, Python off;
#                                                            the level below is then ignored
#   Common/Security/Scripting/MacroSecurityLevel = 3         "Very high": only trusted locations…
#   Common/Security/Scripting/SecureURL = []                 …and there are none
#   Common/Security/Scripting/BlockUntrustedRefererLinks = true
#   Common/Security/Scripting/DisableActiveContent = true    OLE objects and DDE links stay inert
#   Calc/Content/Update/Link = 1, Writer/Content/Update/Link = 2   "never" update links on load
#   Calc/Formula/Load/OOXMLRecalcMode = 0, ODFRecalcMode = 0      "recalc always" on load
#   Calc|Writer/Filter/Import/VBA/Executable = false          VBA is kept for saving, never runnable
# Command-line conversion itself loads documents without a MacroExecutionMode
# (desktop/source/app/dispatchwatcher.cxx), which sfx2 treats as NEVER_EXECUTE; the profile is the second lock.
LO_SETTINGS = [
    ("/org.openoffice.Office.Common/Security/Scripting", "DisableMacrosExecution", "true"),
    ("/org.openoffice.Office.Common/Security/Scripting", "MacroSecurityLevel", "3"),
    ("/org.openoffice.Office.Common/Security/Scripting", "SecureURL", None),
    ("/org.openoffice.Office.Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"),
    ("/org.openoffice.Office.Common/Security/Scripting", "DisableActiveContent", "true"),
    ("/org.openoffice.Office.Calc/Content/Update", "Link", "1"),
    ("/org.openoffice.Office.Writer/Content/Update", "Link", "2"),
    ("/org.openoffice.Office.Calc/Formula/Load", "OOXMLRecalcMode", "0"),
    ("/org.openoffice.Office.Calc/Formula/Load", "ODFRecalcMode", "0"),
    ("/org.openoffice.Office.Calc/Filter/Import/VBA", "Executable", "false"),
    ("/org.openoffice.Office.Writer/Filter/Import/VBA", "Executable", "false"),
]


def write_lo_profile(profile: pathlib.Path) -> None:
    items = []
    for item, prop, value in LO_SETTINGS:
        v = "<value/>" if value is None else f"<value>{value}</value>"
        items.append(f'<item oor:path="{item}"><prop oor:name="{prop}" oor:op="fuse">{v}</prop></item>')
    xcu = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema"'
        ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' + "\n".join(items) + "\n</oor:items>\n"
    )
    user = profile / "user"
    user.mkdir(parents=True, exist_ok=True)
    (user / "registrymodifications.xcu").write_text(xcu, encoding="utf-8")


def run_tree(cmd: list[str], timeout: float, env: dict | None = None) -> tuple[int | None, str]:
    """Run cmd; on timeout kill the whole tree (soffice -> soffice.bin)."""
    kw: dict = {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT, "env": env}
    if WIN:
        kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kw["start_new_session"] = True
    p = subprocess.Popen(cmd, **kw)
    try:
        out, _ = p.communicate(timeout=timeout)
        return p.returncode, out.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        if WIN:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        else:
            try:
                os.killpg(p.pid, 9)
            except OSError:
                pass
        p.communicate()
        return None, "timeout"


def lo_convert(src: pathlib.Path, target: str, a: dict) -> pathlib.Path:
    """soffice --convert-to into a fresh folder under work_dir; returns the produced file."""
    soffice = a.get("soffice")
    if not isinstance(soffice, str) or not os.path.isfile(soffice):
        raise OpError("no_backend", NO_BACKEND)
    work = work_dir(a)
    profile = pathlib.Path(a.get("profile") or (work / "lo-profile")).resolve()
    write_lo_profile(profile)
    outdir = pathlib.Path(tempfile.mkdtemp(prefix="lo-", dir=work))
    env = dict(os.environ)
    if not WIN:
        env.setdefault("HOME", str(profile))  # fontconfig and friends write under HOME
    cmd = [
        soffice,
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nologo",
        "--nodefault",
        f"-env:UserInstallation={profile.as_uri()}",
        "--convert-to",
        LO_FILTER[target],
        "--outdir",
        str(outdir),
        str(src.resolve()),
    ]
    code, out = run_tree(cmd, float(a.get("timeout_s") or LO_TIMEOUT), env)
    produced = outdir / f"{src.stem}.{target}"
    if not produced.is_file():
        tail = " ".join(out.strip().splitlines()[-3:])[-300:]
        if code is None:
            raise OpError("timeout", "LibreOffice не успел обработать файл")
        raise OpError("convert_failed", f"LibreOffice не смог обработать файл ({tail or f'код {code}'})")
    return produced


def find_soffice(root: str | None) -> str | None:
    if not root or not os.path.isdir(root):
        return None
    name = "soffice.exe" if WIN else "soffice"
    base = len(pathlib.Path(root).parts)
    for dirpath, dirnames, filenames in os.walk(root):
        if len(pathlib.Path(dirpath).parts) - base >= 5:
            dirnames[:] = []
        if os.path.basename(dirpath).lower() == "program":
            for f in filenames:
                if f.lower() == name:
                    return os.path.join(dirpath, f)
    return None


# ---------- Microsoft Office over COM (Windows) ----------

PROGID = {"excel": "Excel.Application", "word": "Word.Application", "powerpoint": "PowerPoint.Application"}


def com_registered(progid: str) -> bool:
    import winreg

    def default(key: str) -> str | None:
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, key) as k:
                return winreg.QueryValueEx(k, "")[0]
        except OSError:
            return None

    clsid = default(progid + "\\CLSID")
    if not clsid:
        cur = default(progid + "\\CurVer")
        clsid = cur and default(cur + "\\CLSID")
    if not clsid:
        return False
    # leftovers of an uninstalled Office keep the ProgID; a live local server keeps LocalServer32
    for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
        try:
            with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, f"CLSID\\{clsid}\\LocalServer32", 0, winreg.KEY_READ | view):
                return True
        except OSError:
            pass
    return False


def com_message(e: Exception) -> str:
    info = getattr(e, "excepinfo", None)
    if info and len(info) > 2 and info[2]:
        return str(info[2]).strip()
    return str(e)


@contextmanager
def com_app(kind: str):
    """DispatchEx + the R7 settings; closes nothing it did not open and quits only an app left without documents."""
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    app = None
    saved: dict = {}
    try:
        progid = PROGID[kind]
        # PowerPoint is one instance per system: DispatchEx attaches to the client's own one if it runs
        was_running = False
        if kind == "powerpoint":
            try:
                win32com.client.GetActiveObject(progid)
                was_running = True
            except Exception:
                pass
        try:
            app = win32com.client.DispatchEx(progid)
        except Exception as e:
            raise OpError("office_failed", f"не удалось запустить {kind_name(kind)}: {com_message(e)}")
        saved["DisplayAlerts"] = app.DisplayAlerts
        saved["AutomationSecurity"] = app.AutomationSecurity
        # Excel/Word: False/wdAlertsNone(0); PowerPoint takes ppAlertsNone(1)
        app.DisplayAlerts = 1 if kind == "powerpoint" else 0
        if kind == "excel":
            saved["EnableEvents"] = app.EnableEvents
            app.EnableEvents = False
        if kind == "word":
            # Word.Documents.Open has no UpdateLinks; this option persists, so it is restored below
            saved["UpdateLinksAtOpen"] = app.Options.UpdateLinksAtOpen
            app.Options.UpdateLinksAtOpen = False
        yield app
    finally:
        if app is not None:
            try:
                if "UpdateLinksAtOpen" in saved:
                    app.Options.UpdateLinksAtOpen = saved["UpdateLinksAtOpen"]
                for k in ("EnableEvents", "AutomationSecurity", "DisplayAlerts"):
                    if k in saved:
                        setattr(app, k, saved[k])
                docs = {"excel": "Workbooks", "word": "Documents", "powerpoint": "Presentations"}[kind]
                if not was_running and getattr(app, docs).Count == 0:
                    app.Quit()
            except Exception:
                pass
            app = None
        pythoncom.CoUninitialize()


def kind_name(kind: str) -> str:
    return {"excel": "Excel", "word": "Word", "powerpoint": "PowerPoint"}[kind]


def com_open(app, kind: str, path: pathlib.Path, read_only: bool):
    app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable, before every Open (R7)
    p = str(path.resolve())
    if kind == "excel":
        return app.Workbooks.Open(p, 0, read_only)  # Filename, UpdateLinks=0 (never), ReadOnly
    if kind == "word":
        return app.Documents.Open(p, False, read_only, False)  # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles
    return app.Presentations.Open(p, -1 if read_only else 0, 0, 0)  # FileName, ReadOnly, Untitled, WithWindow (MsoTriState)


def com_close(kind: str, doc) -> None:
    if kind == "excel":
        doc.Close(False)
    elif kind == "word":
        doc.Close(0)  # wdDoNotSaveChanges
    else:
        doc.Close()


def com_save(src: pathlib.Path, kind: str, target: str, out: pathlib.Path) -> None:
    o = str(out.resolve())
    with com_app(kind) as app:
        try:
            doc = com_open(app, kind, src, True)
        except Exception as e:
            raise OpError("office_failed", f"{kind_name(kind)} не открыл файл: {com_message(e)}")
        try:
            if target == "pdf":
                if kind == "excel":
                    doc.ExportAsFixedFormat(0, o)  # xlTypePDF
                elif kind == "word":
                    doc.ExportAsFixedFormat(o, 17)  # wdExportFormatPDF
                else:
                    # ppSaveAsPDF; late-bound Presentation.ExportAsFixedFormat wants a PrintRange object
                    doc.SaveAs(o, 32)
            elif kind == "excel":
                doc.SaveAs(o, 51)  # xlOpenXMLWorkbook
            elif kind == "word":
                doc.SaveAs2(o, 16)  # wdFormatDocumentDefault
            else:
                doc.SaveAs(o, 24)  # ppSaveAsOpenXMLPresentation
        except Exception as e:
            raise OpError("office_failed", f"{kind_name(kind)} не сохранил файл: {com_message(e)}")
        finally:
            try:
                com_close(kind, doc)
            except Exception:
                pass


def com_recalc(src: pathlib.Path) -> None:
    with com_app("excel") as app:
        try:
            wb = com_open(app, "excel", src, False)
        except Exception as e:
            raise OpError("office_failed", f"Excel не открыл файл: {com_message(e)}")
        try:
            app.CalculateFull()
            wb.Save()
        except Exception as e:
            raise OpError("office_failed", f"Excel не пересчитал файл: {com_message(e)}")
        finally:
            try:
                wb.Close(False)
            except Exception:
                pass


# ---------- ops ----------


def op_detect(a: dict) -> dict:
    office = {"excel": False, "word": False, "powerpoint": False}
    if WIN:
        for k in office:
            try:
                office[k] = com_registered(PROGID[k])
            except Exception:
                office[k] = False
    return {"office": office, "soffice": find_soffice(a.get("libreoffice_dir"))}


def op_read(a: dict) -> dict:
    src = source(a)
    ext = src.suffix.lower()
    if ext in LEGACY_READ:
        raise OpError("legacy_format", f"формат {ext} не читается напрямую — сначала office_convert в .docx/.pptx, потом office_read")
    out = a.get("out")
    if not isinstance(out, str) or not out:
        raise OpError("bad_args", "не указан файл для текста (out)")
    from markitdown import FileConversionException, MarkItDown, UnsupportedFormatException

    md = MarkItDown(enable_plugins=False)
    try:
        # markitdown keys the xlsx converter on the extension
        res = md.convert_local(str(src), file_extension=".xlsx") if ext == ".xlsm" else md.convert_local(str(src))
    except UnsupportedFormatException:
        raise OpError("unsupported_format", f"формат {ext or 'без расширения'} не читается: подходят .docx, .xlsx, .xls, .pptx, .pdf")
    except FileConversionException as e:
        raise OpError("read_failed", f"не удалось прочитать файл: {str(e).strip().splitlines()[-1][:300] if str(e).strip() else type(e).__name__}")
    text = getattr(res, "markdown", None) or res.text_content or ""
    dst = pathlib.Path(out)
    dst.parent.mkdir(parents=True, exist_ok=True)
    # newline="" so Windows does not translate \n -> \r\n: the file holds exactly `text`,
    # so the reader counts the same characters (the gate pages office_read by that count).
    dst.write_text(text, encoding="utf-8", newline="")
    return {"chars": len(text)}


def backend_of(a: dict) -> str:
    b = a.get("backend")
    if b == "com" and not WIN:
        raise OpError("no_backend", "Microsoft Office доступен только на Windows")
    if b not in ("com", "libreoffice"):
        raise OpError("no_backend", NO_BACKEND)
    return b


def op_convert(a: dict) -> dict:
    src = source(a)
    ext = src.suffix.lower()
    kind = kind_of(ext)
    to = a.get("to")
    if to not in ("docx", "xlsx", "pptx", "pdf") or kind is None or (to != "pdf" and TARGET_KIND[to] != kind):
        raise OpError("bad_target", f"нельзя преобразовать {ext or 'файл'} в {to}")
    out = a.get("out")
    if not isinstance(out, str) or not out:
        raise OpError("bad_args", "не указан файл результата (out)")
    dst = pathlib.Path(out)
    if dst.suffix.lower() != f".{to}":
        raise OpError("bad_target", f"файл результата должен иметь расширение .{to}")
    if dst.exists():
        raise OpError("out_exists", f"файл {dst.name} уже есть — выберите другое имя")
    refuse_xlm(src)
    backend = backend_of(a)
    dst.parent.mkdir(parents=True, exist_ok=True)
    if backend == "com":
        com_save(src, kind, to, dst)
    else:
        shutil.copyfile(lo_convert(src, to, a), dst)
    return {"out": str(dst)}


def op_recalc(a: dict) -> dict:
    src = source(a)
    ext = src.suffix.lower()
    # XLM check first: such a book is refused before any program opens it
    refuse_xlm(src)
    if ext not in (".xlsx", ".xlsm"):
        raise OpError("unsupported_format", "пересчёт работает с .xlsx и .xlsm — другие форматы сначала office_convert в .xlsx")
    if backend_of(a) == "com":
        com_recalc(src)
    else:
        produced = lo_convert(src, ext[1:], a)
        shutil.copyfile(produced, src)  # in place: same file, new content
    return scan_formulas(src)


ERROR_VALUES = ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A", "#NUM!", "#NULL!")
MAX_ERRORS = 100
MAX_CELLS = 50


def scan_formulas(path: pathlib.Path) -> dict:
    from openpyxl import load_workbook

    def text(v):
        return getattr(v, "text", v)  # ArrayFormula / DataTableFormula

    wf = load_workbook(path, read_only=True, data_only=False)
    wv = load_workbook(path, read_only=True, data_only=True)
    formulas = 0
    sample: list[tuple[str, str, str]] = []
    for ws in wf.worksheets:
        for row in ws.iter_rows():
            for c in row:
                v = getattr(c, "value", None)
                if v is None:
                    continue
                if c.data_type == "f" or (isinstance(v, str) and v.startswith("=")):
                    formulas += 1
                    if len(sample) < MAX_CELLS:
                        sample.append((ws.title, c.coordinate, str(text(v))))
    wanted = {(s, cell) for s, cell, _ in sample}
    values: dict = {}
    errors = []
    errors_total = 0
    for ws in wv.worksheets:
        for row in ws.iter_rows():
            for c in row:
                v = getattr(c, "value", None)
                if v is None:
                    continue
                if c.data_type == "e" or (isinstance(v, str) and v in ERROR_VALUES):
                    errors_total += 1
                    if len(errors) < MAX_ERRORS:
                        errors.append({"sheet": ws.title, "cell": c.coordinate, "value": str(v)})
                if (ws.title, c.coordinate) in wanted:
                    values[(ws.title, c.coordinate)] = v
    wf.close()
    wv.close()
    cells = [{"sheet": s, "cell": cell, "formula": f, "value": values.get((s, cell))} for s, cell, f in sample]
    return {"formulas": formulas, "errors": errors, "errors_total": errors_total, "cells": cells}


def to_pdf(src: pathlib.Path, a: dict) -> pathlib.Path:
    ext = src.suffix.lower()
    if ext == ".pdf":
        return src
    kind = kind_of(ext)
    if kind is None:
        raise OpError("unsupported_format", f"формат {ext or 'без расширения'} не показывается: подходят документы Word, Excel, PowerPoint и PDF")
    refuse_xlm(src)
    if backend_of(a) == "com":
        out = pathlib.Path(tempfile.mkdtemp(prefix="pdf-", dir=work_dir(a))) / f"{src.stem}.pdf"
        com_save(src, kind, "pdf", out)
        return out
    return lo_convert(src, "pdf", a)


def op_render(a: dict) -> dict:
    src = source(a)
    work = work_dir(a)
    width = int(a.get("width") or 1200)
    pages: list[int] = []
    for p in a.get("pages") or [1]:
        if isinstance(p, int) and p >= 1 and p not in pages:
            pages.append(p)
    pages = pages[:3] or [1]
    pdf = to_pdf(src, a)
    import pypdfium2 as pdfium

    outdir = pathlib.Path(tempfile.mkdtemp(prefix="render-", dir=work))
    try:
        doc = pdfium.PdfDocument(str(pdf))
    except Exception as e:
        raise OpError("render_failed", f"не удалось открыть PDF: {e}")
    images = []
    try:
        count = len(doc)
        for p in pages:
            if p > count:
                continue
            page = doc[p - 1]
            try:
                img = page.render(scale=width / page.get_width()).to_pil()
                png = outdir / f"page-{p}.png"
                img.save(png)
            finally:
                page.close()
            images.append({"page": p, "png": str(png)})
    finally:
        doc.close()
    return {"page_count": count, "images": images}


OPS = {"detect": op_detect, "read": op_read, "convert": op_convert, "recalc": op_recalc, "render": op_render}


def main(argv: list[str]) -> int:
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # library chatter must not displace the result line
    code = 0
    try:
        if len(argv) < 3:
            raise OpError("bad_args", "использование: office_ops.py <op> <args.json>")
        raw = argv[2]
        args = json.loads(raw if raw.lstrip().startswith("{") else pathlib.Path(raw).read_text(encoding="utf-8"))
        if not isinstance(args, dict):
            raise OpError("bad_args", "аргументы должны быть JSON-объектом")
        fn = OPS.get(argv[1])
        if fn is None:
            raise OpError("bad_op", f"неизвестная операция: {argv[1]}")
        result = {"ok": True, **fn(args)}
    except OpError as e:
        result = {"ok": False, "code": e.code, "error": e.error}
    except Exception as e:
        traceback.print_exc()
        result = {"ok": False, "code": "internal", "error": f"внутренняя ошибка: {type(e).__name__}: {e}"}
        code = 1
    real_stdout.write(json.dumps(result, ensure_ascii=False, default=str) + "\n")
    real_stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
