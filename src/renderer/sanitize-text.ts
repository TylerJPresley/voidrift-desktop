/**
 * Neutralise Trojan-Source and spoofing controls in model/tool/MCP text before
 * it is rendered in the desktop renderer DOM (desktop-blueprint.md §3).
 *
 * React escapes markup, so untrusted text is inert as HTML, but escaped text
 * nodes still honour Unicode bidirectional overrides: an attacker can reorder
 * the *displayed* characters of a diff, path, or tool argument (Trojan Source)
 * even though the text cannot inject markup or script. This strips the override
 * and directional-mark controls (U+202A–U+202E, U+2066–U+2069, U+200E/U+200F)
 * and the zero-width/format characters used to spoof ASCII identifiers (U+200B–
 * U+200C, U+2060, U+FEFF). Newline and tab are preserved; U+200D (ZWJ) is kept
 * for emoji sequences. Mirrors the CLI's `sanitize()` minus terminal-escape
 * bytes, which have no meaning in a DOM.
 */
export function sanitizeText(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x202a && code <= 0x202e) || // LRE RLE PDF LRO RLO
      (code >= 0x2066 && code <= 0x2069) || // LRI RLI FSI PDI
      code === 0x200e ||
      code === 0x200f || // LRM / RLM
      (code >= 0x200b && code <= 0x200c) || // ZWSP / ZWNJ
      code === 0x2060 ||
      code === 0xfeff // WORD JOINER / ZWNBSP (BOM)
    ) {
      continue;
    }
    out += ch;
  }
  return out;
}
