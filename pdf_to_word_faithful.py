#!/usr/bin/env python3
"""Create a visually identical Word copy of a PDF (one full-page image per page)."""
import argparse
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

EMU_PER_POINT = 12700

def pdf_size(pdf: Path):
    info = subprocess.check_output(['pdfinfo', str(pdf)], text=True, stderr=subprocess.STDOUT)
    match = re.search(r'Page size:\s+([\d.]+) x ([\d.]+) pts', info)
    if not match:
        raise RuntimeError('Could not determine PDF page size.')
    return (float(match.group(1)), float(match.group(2)))

def document_xml(page_count, width_pt, height_pt):
    width, height = round(width_pt * EMU_PER_POINT), round(height_pt * EMU_PER_POINT)
    pages = []
    for index in range(page_count):
        if index:
            pages.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
        rid = f'rId{index + 1}'
        pages.append(f'''<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="1" w:lineRule="exact"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="{width}" cy="{height}"/><wp:docPr id="{index + 1}" name="Original PDF page {index + 1}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="{index + 1}" name="page-{index + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rid}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>''')
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{''.join(pages)}<w:sectPr><w:pgSz w:w="{round(width_pt * 20)}" w:h="{round(height_pt * 20)}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>'''

def convert(source: Path, destination: Path):
    if not shutil.which('pdftoppm') or not shutil.which('pdfinfo'):
        raise RuntimeError('Poppler tools (pdftoppm and pdfinfo) are required.')
    width_pt, height_pt = pdf_size(source)
    with tempfile.TemporaryDirectory() as temp:
        prefix = Path(temp) / 'page'
        subprocess.run(['pdftoppm', '-png', '-r', '220', str(source), str(prefix)], check=True)
        images = sorted(Path(temp).glob('page-*.png'))
        if not images:
            raise RuntimeError('No pages could be rendered from the PDF.')
        content = '''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'''
        root = '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
        rels = ['<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">']
        for i, image in enumerate(images, 1):
            rels.append(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{image.name}"/>')
        rels.append('</Relationships>')
        with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
            archive.writestr('[Content_Types].xml', content)
            archive.writestr('_rels/.rels', root)
            archive.writestr('word/document.xml', document_xml(len(images), width_pt, height_pt))
            archive.writestr('word/_rels/document.xml.rels', ''.join(rels))
            for image in images:
                archive.write(image, f'word/media/{image.name}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Create a visually faithful Word copy of a PDF.')
    parser.add_argument('pdf', type=Path)
    parser.add_argument('-o', '--output', type=Path)
    args = parser.parse_args()
    source = args.pdf.resolve()
    if not source.is_file() or source.suffix.lower() != '.pdf':
        parser.error('pdf must be an existing PDF file')
    output = args.output or source.with_name(source.stem + '_exact_layout.docx')
    convert(source, output)
    print(f'Created: {output}')
