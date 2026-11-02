# UI refinement delivery ledger

Approved scope: Q14 option 2 (Browse documents always primary), all other questions option 1. Website brand is SiYuan Share. README retains Note and its original structure, screenshots and tone, with small matching English/Chinese additions.

## Implementation coverage

| Decisions | Implemented behavior | Verification entry |
| --- | --- | --- |
| Q01–02 | Existing palette, semantic surfaces, both themes and forced colors | ui-refinement-browser; screenshot inspection |
| Q03 + site name | English website brand, labels, errors, metadata and language; custom names preserved | admin_ui; runtime |
| Q04–05 | Main/secondary/danger states, focus, restrained feedback and tool icon sizing; custom document icons retained | frontend; UI/browser; tree-groups |
| Q06–07 | Stable image close, More rotation, keyboard entry, modal isolation and focus return | frontend; ui-refinement-browser; image-sizing |
| Q08–10 | PDF primary scroll, persistent actions, filtering/count/clear, cancellation confirmation and task-state bridge | pdf-ui; pdf-browser; HTTP cancellation tests |
| Q11–13, Q23 | Mobile contents wrapping/focus, quieter tree branches and mobile heading spacing | reader-ui; UI/browser; tree-groups; heading-spacing |
| Q14 | Browse stays primary for first visits and return visits | reader-ui; UI/browser |
| Q15–17 | Card hierarchy, named delete/Undo, permanent confirmation and dirty-edit protection | admin_ui; reader-ui; UI/browser |
| Q18–19 | Password label/error/visibility, shared coarse-pointer controls and 320px calendar | admin_ui; controls; UI/browser; plugin/package |
| Q20 | Complete formula processing before plain-text search excerpt clipping | runtime; HTTP search |
| Q21 | Opaque panels, separate backdrop changes, interruption and Reduced Motion | reader-ui; controls; pdf-browser; UI/browser |
| Q22 | Trusted generated mathematical semantics after sanitization; arbitrary MathML still blocked | frontend; render-security; PDF math/delimiters |
| Q24 | Existing public address setting and explicit HTTPS deployment helper | admin_ui; deployment guard; live configuration gate |
| Final docs | Small README/README_zh_CN additions and behavior/maintenance/PDF guide updates | docs; package; final screenshots |

Generated reader CSS is rebuilt from the shared stylesheet. Plugin packaging takes controls.js/css from the same canonical website source. New pdf-ui is executed by frontend-regression.yml. New ui-refinement-browser is called by the existing test_pdf_browser_rendering_and_save, executed by PHP Actions with --browser. No test expectations were removed to make failures pass.

## Verification record

Passed during implementation: 76 PHP runtime checks; targeted admin Undo, HTTPS configuration and search integration; existing DOM/plugin/render-security/controls/footnotes regressions; packaging and documentation; real Chromium and Edge PDF/UI acceptance; both-theme heading and tree tests; deployment guard simulation. Final full local regression and PR Actions results are recorded in the delivery response after completion.

Edge's internal downloads-hub has an empty Playwright Page URL. The no-extra-application-pages assertion now resolves real browser-level CDP target URLs and excludes only actual edge:// or chrome:// targets in the reader context. Unknown blank pages remain counted. The unrelated MIME experiment was reverted.

## Manual checks not available in this environment

- Physical iOS Safari / Android touch, OS text scaling and actual VoiceOver / TalkBack speech.
- Subjective motion comparison on physical devices and measured frame-rate/battery performance.
- Browser-extension and arbitrary administrator custom-style combinations.

These limitations do not imply a screen-reader certification or a measured animation-performance improvement. Automated MathML, keyboard, high-contrast, reduced-motion, text-size and touch-target checks cover the available environment.

## Merge and deployment gate

PR #10 must pass both existing Actions suites on its final revision before merge. Main's deployment workflow repeats regression for the actual main commit, verifies container health, unchanged core-data fingerprints and SQLite integrity. The explicit apply_public_url deployment option configures the intended HTTPS URL after the normal preservation checks. Live reader/PDF/English-title checks and the final screenshot refresh complete delivery; never treat the initial partial commits as completion.
