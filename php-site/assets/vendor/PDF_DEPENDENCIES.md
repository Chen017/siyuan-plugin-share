# Browser PDF dependency

- Package: `html2pdf.js@0.14.0`, from the upstream npm release.
- Project: https://github.com/eKoopmans/html2pdf.js
- Vendored file: `html2pdf.bundle.min.js` (946143 bytes), locally patched as described below.
- SHA256: `fe2905ee68199b0ccfaca50494ef2b8e1cbdc3241ef9f820b581015069269e0a`.
- npm tarball integrity: `sha512-yvNJgE/8yru2UeGflkPdjW8YEY+nDH5X7/2WG4uiuSCwYiCp8PZ8EKNiTAa6HxJ1NjC51fZSIEq6xld5CADKBQ==`.
- MIT and bundled dependency notices: `html2pdf.LICENSE.txt`.
- Install/audit performed with lifecycle scripts disabled on 2026-10-26; npm audit reported no vulnerabilities for the resolved dependency tree.

The bundled html2canvas list-marker renderer is patched to align marker baselines with the first line of text and center them on the list guide. It retains the generated marker text and numbering. Reapply and verify this patch when updating the upstream bundle; the PDFium list-guide regression checks the rendered PDF.

The bundle is preloaded when the export dialog opens, then executed in each active document's isolated rendering frame. No document is sent to the package authors or a remote PDF service. Export captures one A4 page at a time to avoid a full-document canvas allocation, then downloads one PDF per document. A batch uses at most three document pipelines within a single visitor task; a single document uses one. Direct downloads preserve page artwork and add a Unicode selection layer from measured DOM text through the local `pdf-text-layer.js` helper. No OCR or additional body font download is required.
