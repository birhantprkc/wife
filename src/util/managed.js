/** Full-line markers accepted from every historical wife managed block. */
const BEGIN_LINE = /^[ \t]*<!--[ \t]*wife:begin\b[^\r\n]*-->[ \t]*$/i;
const END_LINE = /^[ \t]*<!--[ \t]*wife:end[ \t]*-->[ \t]*$/i;
const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

function malformed() {
  throw new Error('Malformed wife managed block: expected one complete begin/end marker pair');
}

/**
 * Locate marker lines while respecting Markdown fenced code outside blocks.
 *
 * A documented literal marker inside ``` or ```` is user text, not ownership.
 * Once a real begin marker is found, however, Wife owns that region and scans
 * directly for its matching end; code-like text generated inside the block
 * must not be able to hide the closing marker.
 */
function markerTokens(text) {
  const current = String(text || '');
  const tokens = [];
  let offset = 0;
  let fence = null;
  let managedDepth = 0;

  while (offset < current.length) {
    const newline = current.indexOf('\n', offset);
    const lineEnd = newline === -1 ? current.length : newline;
    const rawLine = current.slice(offset, lineEnd);
    const carriage = rawLine.endsWith('\r') ? 1 : 0;
    const line = carriage ? rawLine.slice(0, -1) : rawLine;
    const tokenEnd = lineEnd - carriage;

    if (managedDepth > 0) {
      if (BEGIN_LINE.test(line)) {
        tokens.push({ type: 'begin', start: offset, end: tokenEnd });
        managedDepth++;
      } else if (END_LINE.test(line)) {
        tokens.push({ type: 'end', start: offset, end: tokenEnd });
        managedDepth--;
      }
    } else {
      const fenceMatch = FENCE_LINE.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[1];
        if (!fence) fence = { char: marker[0], length: marker.length };
        // CommonMark closing fences cannot carry an info string. A line such
        // as ````html inside a longer documentation example is content, not a
        // close that exposes the marker literals following it.
        else if (marker[0] === fence.char && marker.length >= fence.length && !fenceMatch[2].trim()) fence = null;
      } else if (!fence && BEGIN_LINE.test(line)) {
        tokens.push({ type: 'begin', start: offset, end: tokenEnd });
        managedDepth = 1;
      } else if (!fence && END_LINE.test(line)) {
        tokens.push({ type: 'end', start: offset, end: tokenEnd });
      }
    }

    if (newline === -1) break;
    offset = newline + 1;
  }
  return tokens;
}

/** Locate every complete managed block without treating documentation as one. */
export function findManagedBlocks(text = '') {
  const blocks = [];
  let begin = null;
  for (const token of markerTokens(text)) {
    if (!begin) {
      if (token.type === 'begin') begin = token;
      continue; // orphan end markers belong to the user
    }
    if (token.type === 'begin') return malformed();
    blocks.push({ start: begin.start, end: token.end });
    begin = null;
  }
  if (begin) return malformed();
  return blocks;
}

/**
 * Strip managed output for import. This variant is deliberately fail-closed:
 * nested markers are consumed as one region and an unclosed begin drops the
 * tail, so Wife can never mine its own truncated output.
 */
export function stripManagedOutput(text = '') {
  const current = String(text || '');
  const blocks = [];
  let depth = 0;
  let start = null;
  for (const token of markerTokens(current)) {
    if (token.type === 'begin') {
      if (depth === 0) start = token.start;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0) {
        blocks.push({ start, end: token.end });
        start = null;
      }
    }
  }
  if (depth > 0 && start !== null) blocks.push({ start, end: current.length });
  if (!blocks.length) return current;

  let next = '';
  let cursor = 0;
  for (const block of blocks) {
    next += current.slice(cursor, block.start);
    cursor = block.end;
  }
  return next + current.slice(cursor);
}

export function findManagedBlock(text = '') {
  return findManagedBlocks(text)[0] || null;
}

export function hasManagedBlock(text = '') {
  try {
    return findManagedBlocks(text).length > 0;
  } catch {
    return false;
  }
}

export function upsertManagedBlock(existing, block) {
  const current = String(existing || '');
  const found = findManagedBlocks(current);
  if (found.length) {
    let next = '';
    let cursor = 0;
    for (let i = 0; i < found.length; i++) {
      next += current.slice(cursor, found[i].start);
      if (i === 0) next += block;
      cursor = found[i].end;
    }
    return next + current.slice(cursor);
  }
  const prefix = current.trim() ? `${current.trimEnd()}\n\n` : '';
  return `${prefix}${String(block).trimEnd()}\n`;
}

export function removeManagedBlock(existing) {
  const current = String(existing || '');
  const found = findManagedBlocks(current);
  if (!found.length) return { text: current, removed: false };
  let next = '';
  let cursor = 0;
  for (const block of found) {
    next += current.slice(cursor, block.start);
    cursor = block.end;
  }
  next += current.slice(cursor);
  return { text: next, removed: true };
}
