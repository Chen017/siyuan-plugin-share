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

Passed during implementation: 78 PHP runtime checks; targeted admin Undo, HTTPS configuration and search integration; existing DOM/plugin/render-security/controls/footnotes regressions; packaging and documentation; real Chromium and Edge PDF/UI acceptance; both-theme heading and tree tests; deployment guard simulation. The full local run passed 68 cases with only the Docker/Nginx case skipped locally; the final PR PHP Actions ran all 68 in Docker successfully. Both feature PR Actions passed before merge.

Edge's internal downloads-hub has an empty Playwright Page URL. The no-extra-application-pages assertion now resolves real browser-level CDP target URLs and excludes only actual edge:// or chrome:// targets in the reader context. Unknown blank pages remain counted. The unrelated MIME experiment was reverted.

## Manual checks not available in this environment

- Physical iOS Safari / Android touch, OS text scaling and actual VoiceOver / TalkBack speech.
- Subjective motion comparison on physical devices and measured frame-rate/battery performance.
- Browser-extension and arbitrary administrator custom-style combinations.

These limitations do not imply a screen-reader certification or a measured animation-performance improvement. Automated MathML, keyboard, high-contrast, reduced-motion, text-size and touch-target checks cover the available environment.

## Merge and deployment gate

PR #10 passed both Actions suites and merged as 20f7810. Deployment 41524316418 passed regression, service health, core-data preservation and SQLite integrity. Explicit HTTPS configuration deployment 41524405529 also completed successfully without changing PDF limits. Live checks confirmed the English title, mathematical semantics, PDF filter/count/clear and missing-share language; all three existing README screenshots were refreshed in place.

Live dark-mode inspection found that root-level semantic aliases retained light values when the reader overrides its palette on body. The final verification branch moves aliases to the actual page-theme scope and adds panel/control text-contrast assertions to every browser theme/viewport combination. It also unifies the legacy search fallback descriptions. This final branch must pass both existing Actions suites before merge; the subsequent main deployment and live dark-mode recheck complete delivery.
