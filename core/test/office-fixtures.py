"""Test fixtures for office tests, built with the bridge's own venv libraries.

Usage: python office-fixtures.py <kind> <out> [arg]
kinds: docx, xlsx, xlsx-xlm, xls-xlm, xls-plain, pptx, pdf, odt-macro <marker path>
"""

import struct
import sys
import zipfile
from xml.sax.saxutils import escape


def docx(out):
    from docx import Document

    d = Document()
    d.add_heading("Отчёт DOCX-MARKER", 1)
    d.add_paragraph("Первая страница: проверка чтения.")
    d.save(out)


def xlsx(out):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Лист1"
    ws["A1"], ws["A2"], ws["A3"] = 1, 2, 3
    ws["A4"] = "=SUM(A1:A3)"
    ws["B1"] = "XLSX-MARKER"
    wb.save(out)


def xlsx_errors(out):
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws["A1"] = 1
    ws["A2"] = "=A1/0"
    wb.save(out)


def xlsx_xlm(out):
    # a normal book plus an Excel 4.0 macro sheet part, as Excel writes it into .xlsm
    xlsx(out)
    with zipfile.ZipFile(out, "a") as z:
        z.writestr(
            "xl/macrosheets/sheet1.xml",
            '<?xml version="1.0" encoding="UTF-8"?><xm:macrosheet xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"/>',
        )


def cfb(stream_name, data):
    """Minimal compound file (v3, 512-byte sectors) with one stream >= 4096 bytes (no mini stream)."""
    data = data + b"\0" * (-len(data) % 512)
    assert len(data) >= 4096
    n = len(data) // 512
    free, end, fatsect, nostream = 0xFFFFFFFF, 0xFFFFFFFE, 0xFFFFFFFD, 0xFFFFFFFF
    fat = [fatsect, end] + [3 + i for i in range(n - 1)] + [end]
    fat += [free] * (128 - len(fat))
    header = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 16
    header += struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6) + b"\0" * 6
    header += struct.pack("<IIIIIIIII", 0, 1, 1, 0, 4096, end, 0, end, 0)
    header += struct.pack("<109I", 0, *([free] * 108))

    def entry(name, typ, child, start, size):
        raw = (name + "\0").encode("utf-16-le") if name else b""
        e = raw.ljust(64, b"\0") + struct.pack("<HBB", len(raw), typ, 1)
        e += struct.pack("<III", nostream, nostream, child) + b"\0" * 16 + b"\0" * 4 + b"\0" * 16
        return e + struct.pack("<IQ", start, size)

    dirs = entry("Root Entry", 5, 1, end, 0) + entry(stream_name, 2, nostream, 2, len(data))
    dirs += (b"\0" * 64 + struct.pack("<HBB", 0, 0, 0) + struct.pack("<III", nostream, nostream, nostream) + b"\0" * 48) * 2
    return header + struct.pack("<128I", *fat) + dirs + data


def biff_book(sheet_type):
    bof = struct.pack("<HH", 0x0809, 16) + struct.pack("<HHHHII", 0x0600, 0x0005, 0, 0, 0, 0)
    name = b"Macro1"
    bs_body = struct.pack("<IBB", 0, 0, sheet_type) + struct.pack("<BB", len(name), 0) + name
    boundsheet = struct.pack("<HH", 0x0085, len(bs_body)) + bs_body
    eof = struct.pack("<HH", 0x000A, 0)
    stream = bof + boundsheet + eof
    return cfb("Workbook", stream + b"\0" * (4096 - len(stream)))


def pptx(out):
    from pptx import Presentation

    p = Presentation()
    s = p.slides.add_slide(p.slide_layouts[0])
    s.shapes.title.text = "Слайд PPTX-MARKER"
    p.save(out)


def pdf(out):
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(out)
    c.drawString(72, 720, "PDF-MARKER first page")
    c.showPage()
    c.drawString(72, 720, "second page")
    c.save()


def odt_macro(out, marker):
    """ODF text document whose Basic macro runs on open (dom:load) and writes the marker file."""
    basic = f"""Sub OnOpen
  Dim n As Integer
  n = FreeFile()
  Open "{marker}" For Output As #n
  Print #n, "macro ran"
  Close #n
End Sub
"""
    content = """<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dom="http://www.w3.org/2001/xml-events" xmlns:ooo="http://openoffice.org/2004/office" office:version="1.3">
 <office:scripts>
  <office:event-listeners>
   <script:event-listener script:language="ooo:script" script:event-name="dom:load" xlink:href="vnd.sun.star.script:Standard.Module1.OnOpen?language=Basic&amp;location=document" xlink:type="simple"/>
  </office:event-listeners>
 </office:scripts>
 <office:body><office:text><text:p>ODT-MACRO-MARKER</text:p></office:text></office:body>
</office:document-content>
"""
    lc = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:libraries PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "libraries.dtd">
<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">
 <library:library library:name="Standard" library:link="false"/>
</library:libraries>
"""
    lb = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE library:library PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "library.dtd">
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
 <library:element library:name="Module1"/>
</library:library>
"""
    module = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">\n'
        '<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic" script:moduleType="normal">'
        + escape(basic)
        + "</script:module>\n"
    )
    manifest = """<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
 <manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="application/vnd.oasis.opendocument.text"/>
 <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="Basic/Standard/Module1.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="Basic/Standard/script-lb.xml" manifest:media-type="text/xml"/>
 <manifest:file-entry manifest:full-path="Basic/script-lc.xml" manifest:media-type="text/xml"/>
</manifest:manifest>
"""
    with zipfile.ZipFile(out, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/vnd.oasis.opendocument.text", compress_type=zipfile.ZIP_STORED)
        z.writestr("content.xml", content, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Basic/script-lc.xml", lc, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Basic/Standard/script-lb.xml", lb, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("Basic/Standard/Module1.xml", module, compress_type=zipfile.ZIP_DEFLATED)
        z.writestr("META-INF/manifest.xml", manifest, compress_type=zipfile.ZIP_DEFLATED)


def main():
    kind, out = sys.argv[1], sys.argv[2]
    if kind == "docx":
        docx(out)
    elif kind == "xlsx":
        xlsx(out)
    elif kind == "xlsx-errors":
        xlsx_errors(out)
    elif kind == "xlsx-xlm":
        xlsx_xlm(out)
    elif kind == "xls-xlm":
        open(out, "wb").write(biff_book(1))
    elif kind == "xls-plain":
        open(out, "wb").write(biff_book(0))
    elif kind == "pptx":
        pptx(out)
    elif kind == "pdf":
        pdf(out)
    elif kind == "odt-macro":
        odt_macro(out, sys.argv[3])
    else:
        raise SystemExit(f"unknown kind {kind}")


main()
