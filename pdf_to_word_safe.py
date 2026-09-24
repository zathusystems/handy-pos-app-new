#!/usr/bin/env python3
"""Convert text-based PDFs to editable DOCX files while retaining line layout.

Requires Poppler's ``pdftotext`` command (included on most Linux systems).
Scanned/image-only PDFs need OCR before conversion.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile

CONTENT_TYPES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''
ROOT_RELS = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

def paragraph(line: str) -> str:
    """A fixed-width paragraph preserves PDF spacing and remains editable in Word."""
    if not line:
        return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
    return ('<w:p><w:pPr><w:spacing w:after="0" w:line="220" w:lineRule="auto"/>'
            '<w:ind w:left="0" w:right="0"/></w:pPr><w:r><w:rPr>'
            '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/>'
            '<w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">' +
            escape(line) + '</w:t></w:r></w:p>')

def page_break() -> str:
    return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

def write_docx(pages: list[str], destination: Path) -> None:
    body = []
    for number, page in enumerate(pages):
        if number:
            body.append(page_break())
        body.extend(paragraph(line) for line in page.splitlines())
    document = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080"/></w:sectPr></w:body>
</w:document>''' % ''.join(body)
    with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
        archive.writestr('[Content_Types].xml', CONTENT_TYPES)
        archive.writestr('_rels/.rels', ROOT_RELS)
        archive.writestr('word/document.xml', document)

def unique_destination(pdf: Path, requested: str | None) -> Path:
    destination = Path(requested) if requested else pdf.with_name(pdf.stem + '_editable.docx')
    if destination.suffix.lower() != '.docx':
        destination = destination.with_suffix('.docx')
    candidate, count = destination, 2
    while candidate.exists():
        candidate = destination.with_name(f'{destination.stem}_{count}{destination.suffix}')
        count += 1
    return candidate

def main() -> int:
    parser = argparse.ArgumentParser(
        description='Convert a text-based PDF to an editable Word document without overwriting anything.'
    )
    parser.add_argument('pdf', type=Path, help='source PDF')
    parser.add_argument('-o', '--output', help='destination DOCX (optional)')
    args = parser.parse_args()
    source = args.pdf.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() != '.pdf':
        parser.error('pdf must be an existing .pdf file')
    if not shutil.which('pdftotext'):
        print('Missing dependency: install Poppler (pdftotext).', file=sys.stderr)
        return 2
    destination = unique_destination(source, args.output)
    with tempfile.NamedTemporaryFile(suffix='.txt', delete=False) as extracted:
        extracted_path = Path(extracted.name)
    try:
        result = subprocess.run(
            ['pdftotext', '-layout', '-enc', 'UTF-8', str(source), str(extracted_path)],
            capture_output=True, text=True
        )
        if result.returncode:
            print(result.stderr.strip() or 'Could not read the PDF.', file=sys.stderr)
            return result.returncode
        text = extracted_path.read_text(encoding='utf-8', errors='replace')
    finally:
        extracted_path.unlink(missing_ok=True)
    if not text.strip():
        print('No selectable text was found. This appears to be a scanned PDF; OCR it first.', file=sys.stderr)
        return 3
    write_docx(text.split('\f'), destination)
    print(f'Created: {destination}')
    print('Tip: use Word’s “Save As” for further edits; the original PDF remains unchanged.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
