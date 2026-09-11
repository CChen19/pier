/**
 * ANSI-aware text measurement and clipping for pier's TUI surfaces.
 *
 * Why a local implementation: the todo widget, the pinned pane title and the
 * ask_user_question multi-select all need width-correct clipping, but importing
 * `visibleWidth`/`truncateToWidth` from pi-tui would make those paths depend on a
 * package that may be absent in stripped installs. The table below only has to be
 * right for ASCII plus the CJK/emoji ranges that actually appear in user content.
 */

const SGR = /\x1b\[[0-9;]*m/y;

/** Approximate terminal cell width of one code point (0, 1 or 2). */
export function charWidth(cp: number): number {
  if (cp < 32) return 0;
  if (cp >= 0x7f && cp < 0xa0) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining marks
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e)
    || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Rendered cell width of a string that may contain SGR sequences (zero width). */
export function styledWidth(line: string): number {
  let width = 0;
  let i = 0;
  while (i < line.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(line);
    if (m && m.index === i) {
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    width += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return width;
}

/**
 * Cut a styled line to `width` cells without breaking escape sequences.
 * Wide glyphs count as two cells, so CJK content stays inside the frame.
 */
export function truncateStyled(line: string, width: number): string {
  if (width <= 0) return '';
  if (styledWidth(line) <= width) return line;
  const keep = Math.max(0, width - 1); // reserve one cell for the ellipsis
  let out = '';
  let used = 0;
  let i = 0;
  while (i < line.length) {
    SGR.lastIndex = i;
    const m = SGR.exec(line);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const w = charWidth(cp);
    if (used + w > keep) break;
    out += cp > 0xffff ? line.slice(i, i + 2) : line[i]!;
    used += w;
    i += cp > 0xffff ? 2 : 1;
  }
  return `${out}\x1b[0m…`;
}
