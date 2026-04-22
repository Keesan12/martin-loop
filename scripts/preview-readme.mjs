import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(__dirname, "../README.md"), "utf8");

// Fix image path to be absolute for local file preview
const fixedReadme = readme.replace(
  /src="\.\/docs\/assets\//g,
  `src="file:///C:/Users/Gobi/Desktop/MartinLoop/martin-loop/docs/assets/`
);

// Escape for embedding in a JS template literal
const escaped = fixedReadme
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\${/g, "\\${");

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>MartinLoop README Preview</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown-light.min.css">
<style>
  body { background: #f6f8fa; }
  .markdown-body { box-sizing: border-box; min-width: 200px; max-width: 980px; margin: 0 auto; padding: 45px; background: #fff; border: 1px solid #d0d7de; border-radius: 6px; margin-top: 24px; margin-bottom: 24px; }
  img { max-width: 100%; border-radius: 6px; }
</style>
</head>
<body>
<div class="markdown-body" id="content"></div>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
const md = \`${escaped}\`;
document.getElementById('content').innerHTML = marked.parse(md);
</script>
</body>
</html>`;

const outPath = join(tmpdir(), "martinloop-readme-preview.html");
writeFileSync(outPath, html, "utf8");
console.log("Preview written to:", outPath);

// Open in default browser on Windows
execSync(`start "" "${outPath}"`, { shell: true });
console.log("Opened in browser.");
