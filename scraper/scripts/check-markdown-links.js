"use strict";

// Dependency-free checker for repository-local Markdown targets. External
// URLs and heading anchors are intentionally outside this small CI contract.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const markdown = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      markdown.push(full);
  }
}

walk(root);
const failures = [];
const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
for (const file of markdown) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1].replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue;
    const decoded = decodeURIComponent(
      target.split("#", 1)[0].split("?", 1)[0],
    );
    if (!decoded) continue;
    const resolved = path.resolve(path.dirname(file), decoded);
    if (!fs.existsSync(resolved))
      failures.push(`${path.relative(root, file)} -> ${target}`);
  }
}

if (failures.length) {
  console.error("Broken local Markdown links:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${markdown.length} Markdown files; local links resolve.`,
  );
}
