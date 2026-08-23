import {
  MARTIN_ARCADE_MIME_TYPE,
  MARTIN_ARCADE_RESOURCE_URI,
  supportsMartinArcadeApp
} from "./capabilities.js";

const ARCADE_APP_HTML = `<!doctype html>
<html lang="en" data-martin-arcade-app>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MartinLoop Arcade</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(42rem, calc(100% - 2rem)); border: 1px solid currentColor; padding: 1.25rem; }
    p { line-height: 1.5; }
  </style>
</head>
<body>
  <main aria-labelledby="arcade-title">
    <h1 id="arcade-title">MartinLoop Arcade</h1>
    <p>Presentation only. Governed run status and outcomes remain authoritative in MartinLoop.</p>
    <p aria-live="polite" data-run-status>Waiting for authoritative run evidence.</p>
  </main>
</body>
</html>`;

export function listArcadeResources(capabilities: unknown) {
  return {
    resources: supportsMartinArcadeApp(capabilities)
      ? [
          {
            uri: MARTIN_ARCADE_RESOURCE_URI,
            name: "MartinLoop Arcade",
            description: "Presentation-only Arcade view for a governed MartinLoop run.",
            mimeType: MARTIN_ARCADE_MIME_TYPE,
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
          }
        ]
      : []
  };
}

export async function readArcadeResource(uri: string) {
  if (uri !== MARTIN_ARCADE_RESOURCE_URI) {
    throw new Error(`Unknown Arcade resource: ${uri}`);
  }

  return {
    contents: [
      {
        uri: MARTIN_ARCADE_RESOURCE_URI,
        mimeType: MARTIN_ARCADE_MIME_TYPE,
        text: ARCADE_APP_HTML,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
      }
    ]
  };
}
