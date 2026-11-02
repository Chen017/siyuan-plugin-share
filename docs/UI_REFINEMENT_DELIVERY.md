# UI refinement delivery ledger — 2026-11-02

Baseline: d367c8a. Work branch: codex/ui-refinement-20261102. First implementation: dc3beac.

Approved decisions: Q14 option 2 (Browse documents remains primary); every other question option 1. Website brand: SiYuan Share. README remains Note and receives small additions only after implementation and validation.

## Implemented in first batch

English site identity and metadata; old default-name compatibility; English error pages; persistent share-password label, associated errors and visibility control; trusted KaTeX MathML generated after ordinary HTML sanitization (raw MathML remains blocked); mobile contents focus restoration; image keyboard entry, modal semantics, background inert restoration, named thumbnails and selected state; independent fixed image close button and rotation actions in More; mobile heading spacing and initial mobile contents wrapping.

Behavior coverage extends existing frontend.cjs, reader-ui.cjs and admin_ui.py entrypoints. Existing Actions execute the first two directly and admin_ui.py through tests/run.py. Heading coverage extends the existing heading-spacing.cjs job. Shared CSS was regenerated using the existing generator.

## Remaining before merge

- Complete theme surfaces, button/state and tool-icon consistency.
- PDF single primary scroll area, compact information, persistent actions/count, filtering/clear, and cancellation confirmation/state coordination.
- Full image layout/keyboard acceptance in real browsers; make More keyboard behavior and focus navigation robust.
- Contents wrapping acceptance, tree decoration and welcome layout (Browse always primary).
- Admin card styling, deletion feedback/Undo, permanent-delete target confirmation and unsaved-edit protection.
- Shared date/select touch sizing, including 320px calendar geometry and plugin checks (initial site-only height rule is not completion).
- Server-side search summary processing before truncation.
- Opaque panel/separate backdrop motion and Reduced Motion acceptance.
- HTTPS public URL configuration verification.
- Final README/README_zh_CN additions and refreshed existing screenshots.

## Verification so far

Passed locally: frontend, reader-ui, controls, footnotes, render-security, generated CSS consistency, documentation links, PHP syntax, 72 PHP runtime checks, 66 HTTP regression cases with 4 environment-based skips, and real Edge heading tests at 320/390/1100px across light/dark reader/PDF layouts.

Local HTTP skips: Docker/Nginx, full PDF browser save, long-document browser download, real SVG browser isolation. Screen-reader, physical mobile devices, high contrast, 200% text zoom, complete visual matrix and production acceptance remain unverified. Initial sandbox PHP-server startup failed; rerunning the unchanged tests outside the sandbox succeeded. No tests were weakened.

Branch Actions: frontend run 41457028683; PHP run 41457034816. Results must be checked. PR creation was denied by both the GitHub connector and CLI; workflow_dispatch succeeded. No merge or deployment has occurred. Never merge this partial implementation merely because these two first-batch runs pass.
