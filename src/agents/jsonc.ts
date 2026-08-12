export function parseJsonc(text: string): unknown {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out.push(ch); i += 1;
      while (i < text.length) {
        const current = text[i]; out.push(current); i += 1;
        if (current === "\\" && i < text.length) { out.push(text[i]); i += 1; continue; }
        if (current === '"') break;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2; while (i < text.length && text[i] !== "\n") i += 1; continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2; while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1; i += 2; continue;
    }
    out.push(ch); i += 1;
  }
  const withoutTrailingCommas = out.join("").replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}
