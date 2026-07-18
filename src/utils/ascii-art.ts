export function normalizeAsciiArt(text: string): string {
  let normalized = text.replace(/\r\n/g, "\n");
  normalized = normalized.replace(/^```[^\n]*\n/, "");
  normalized = normalized.replace(/\n```$/, "");

  const lines = normalized.split("\n");

  while (lines.length > 0) {
    const firstLine = lines[0];
    if (firstLine === undefined || firstLine.trim() !== "") {
      break;
    }
    lines.shift();
  }
  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    if (lastLine === undefined || lastLine.trim() !== "") {
      break;
    }
    lines.pop();
  }

  return lines.join("\n");
}
