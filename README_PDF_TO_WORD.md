# Safe PDF-to-Word Converter

`pdf_to_word_safe.py` is a standalone Linux command-line program. It creates an editable `.docx` without changing or deleting the source PDF.

Run it from a terminal:

```bash
python3 pdf_to_word_safe.py /path/to/document.pdf
```

To choose an output name:

```bash
python3 pdf_to_word_safe.py /path/to/document.pdf --output /path/to/converted.docx
```

The converter uses Poppler’s `pdftotext -layout` mode, retaining spaces and line positions in a fixed-width Word document. This is best for normal PDFs with selectable text. It deliberately creates a new filename if the chosen one already exists.

Scanned/image-only PDFs must be OCR-processed first. As with all PDF-to-Word conversions, complex artwork, multi-column flow, embedded forms, and unusual fonts may need small manual adjustments after conversion.
