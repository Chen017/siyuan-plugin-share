# Custom page code

Site settings retain HTML Head insertion, custom CSS and custom JavaScript.

- Scope CSS to `body.layout-share` or `body.layout-app`.
- CSS loads after the core stylesheet.
- JavaScript is disabled by default and runs after `DOMContentLoaded` when enabled.
- Head HTML is inserted unchanged; use only trusted code.
- Markdown notes and uploaded HTML retain the existing sanitization and access checks.

Example CSS:

```css
body.layout-share .markdown-body { max-width: 980px; }
```
