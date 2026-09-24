# pdf

Display pdf in VSCode.

![screenshot](https://user-images.githubusercontent.com/3643499/84454816-98fcd600-ac96-11ea-822c-3ae1e1599a13.gif)

## Contribute

### Upgrade PDF.js

1. Download the latest `pdfjs-*-legacy-dist.zip` from [PDF.js releases](https://github.com/mozilla/pdf.js/releases).
1. Extract the ZIP file and replace `./lib/build` and `./lib/web` with the extracted directories.
1. Remove the sample PDF `lib/web/compressed.tracemonkey-pldi-09.pdf`.
1. In `lib/web/viewer.mjs`, remove the `keydown` listener that calls `window.print()` on Ctrl/Cmd+P, so the shortcut reaches VS Code (see the `vscode-pdf` comment in the current copy).
1. If the `<body>` of `lib/web/viewer.html` changed, copy it into the HTML template in `src/pdfPreview.ts`.
1. Check that the viewer options and APIs used by `lib/main.mjs` still exist.

## Change log
See [CHANGELOG.md](CHANGELOG.md).

## License
Please see [LICENSE](./LICENSE)
