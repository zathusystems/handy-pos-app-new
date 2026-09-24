from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

OUT = "Professional_Letterhead_Template.docx"

def p(text="", style=None, align=None, bold=False, color=None, size=None):
    props = ""
    if style: props += f'<w:pStyle w:val="{style}"/>'
    if align: props += f'<w:jc w:val="{align}"/>'
    rpr = ("<w:rPr>" + ("<w:b/>" if bold else "") +
           (f'<w:color w:val="{color}"/>' if color else "") +
           (f'<w:sz w:val="{size}"/>' if size else "") + "</w:rPr>")
    return f'<w:p><w:pPr>{props}</w:pPr><w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'

document = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
%s
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1800" w:right="1440" w:bottom="1500" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
<w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr>
</w:body></w:document>""" % "\n".join([
    p("15 September 2026", align="right", color="536578", size="20"),
    p("", size="12"), p("Dear [Recipient Name],"),
    p("RE: [SUBJECT OF LETTER]", bold=True, color="12344D"),
    p("Use this space for your letter content. The layout has been designed to present your business professionally while keeping the correspondence clean, easy to read, and fully editable in Microsoft Word."),
    p("Replace the sample company name, contact information, and address with your own details. You can also change the initials inside the logo mark to match your business name."),
    p("Thank you for your time and consideration. We look forward to working with you."),
    p("", size="14"), p("Kind regards,"), p("[Your Name]", bold=True), p("[Your Title]"), p("ACME CONSULTING", bold=True, color="167B8B")
])

header = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:bottom w:val="single" w:sz="20" w:space="10" w:color="167B8B"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="900"/><w:gridCol w:w="4000"/><w:gridCol w:w="3300"/></w:tblGrid><w:tr>
<w:tc><w:tcPr><w:tcW w:w="900" w:type="dxa"/><w:shd w:val="clear" w:fill="167B8B"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="30"/></w:rPr><w:t>AC</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="12344D"/><w:sz w:val="36"/></w:rPr><w:t>ACME CONSULTING</w:t></w:r></w:p><w:p><w:r><w:rPr><w:color w:val="68788A"/><w:sz w:val="16"/></w:rPr><w:t>STRATEGY • SOLUTIONS • GROWTH</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:tcW w:w="3300" w:type="dxa"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="167B8B"/><w:sz w:val="18"/></w:rPr><w:t>+265 999 123 456</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="536578"/><w:sz w:val="18"/></w:rPr><w:t>hello@acmeconsulting.com</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:rPr><w:color w:val="536578"/><w:sz w:val="18"/></w:rPr><w:t>www.acmeconsulting.com</w:t></w:r></w:p></w:tc>
</w:tr></w:tbl></w:hdr>"""

footer = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="6" w:space="8" w:color="B8D8DC"/></w:pBdr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:color w:val="68788A"/><w:sz w:val="16"/></w:rPr><w:t>123 Business Avenue, Blantyre, Malawi  |  +265 999 123 456  |  hello@acmeconsulting.com  |  www.acmeconsulting.com</w:t></w:r></w:p></w:ftr>"""

content_types = '''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>'''
root_rels = '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'''
doc_rels = '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>'''

with ZipFile(OUT, "w", ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", content_types)
    z.writestr("_rels/.rels", root_rels)
    z.writestr("word/document.xml", document)
    z.writestr("word/header1.xml", header)
    z.writestr("word/footer1.xml", footer)
    z.writestr("word/_rels/document.xml.rels", doc_rels)
