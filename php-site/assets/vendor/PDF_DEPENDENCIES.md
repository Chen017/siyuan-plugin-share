# Browser PDF dependency

- Package: `html2pdf.js@0.14.0`, from the upstream npm release.
- Project: https://github.com/eKoopmans/html2pdf.js
- Vendored file: `html2pdf.bundle.min.js` (946030 bytes).
- SHA256: `9563c45f032179c73454293a649929e60fc24c05a326e8ab2811cfa8f25c3607`.
- npm tarball integrity: `sha512-yvNJgE/8yru2UeGflkPdjW8YEY+nDH5X7/2WG4uiuSCwYiCp8PZ8EKNiTAa6HxJ1NjC51fZSIEq6xld5CADKBQ==`.
- MIT and bundled dependency notices: `html2pdf.LICENSE.txt`.
- Install/audit performed with lifecycle scripts disabled on 2026-10-26; npm audit reported no vulnerabilities for the resolved dependency tree.

The bundle is preloaded when the export dialog opens, then executed in each active document's isolated rendering frame. No document is sent to the package authors or a remote PDF service. Export captures one A4 page at a time to avoid a full-document canvas allocation, then downloads one PDF per document. A batch uses at most three document pipelines within a single visitor task; a single document uses one. Direct downloads preserve page artwork and add a Unicode selection layer from measured DOM text through the local `pdf-text-layer.js` helper. No OCR or additional body font download is required.
