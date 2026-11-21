// A fast drop-in replacement for csv-reader 1.0.0: run(input) returns exactly the answer csv-reader
// returns for every input {text, header} — {columns, rows, errors} under csv-reader's broken-row policy —
// but reads the text with slice-based field extraction instead of one-character-at-a-time concatenation.
//
// The policy, matched exactly:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled ("" inside it is one
//     quote, and each CRLF or lone CR inside it is read as LF); what follows its closing quote, up to the
//     next comma or line break, is appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character, and the text after it is read again as unquoted
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (short_row, with fields: its field count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (counting every LF,
//     CRLF and lone CR inside quotes), row its record's index in rows (null for the header), in the
//     order met, a record's short_row or long_row when the record ends.
//
// Pure: no clock, no randomness, nothing kept from one call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The last field read: its value, how it ended, and how many characters an unquoted read kept.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters from pos onto `initial` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Sets fValue, fEnded and fAdded (the characters kept).
  function readUnquoted(initial) {
    let start = pos;
    let parts = null; // slices kept so far, when stray CRs cut the field into pieces
    let added = 0;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        // ','
        const tail = text.slice(start, i);
        fValue = parts === null ? initial + tail : initial + parts.join('') + tail;
        fAdded = added + (i - start);
        fEnded = COMMA;
        pos = i + 1;
        return;
      }
      if (c === 10) {
        // LF
        const tail = text.slice(start, i);
        fValue = parts === null ? initial + tail : initial + parts.join('') + tail;
        fAdded = added + (i - start);
        fEnded = LINE_BREAK;
        pos = i + 1;
        line += 1;
        return;
      }
      if (c === 13) {
        // CR
        if (text.charCodeAt(i + 1) === 10) {
          const tail = text.slice(start, i);
          fValue = parts === null ? initial + tail : initial + parts.join('') + tail;
          fAdded = added + (i - start);
          fEnded = LINE_BREAK;
          pos = i + 2;
          line += 1;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [];
        parts.push(text.slice(start, i));
        added += i - start;
        i += 1;
        start = i;
        continue;
      }
      i += 1;
    }
    const tail = text.slice(start, n);
    fValue = parts === null ? initial + tail : initial + parts.join('') + tail;
    fAdded = added + (n - start);
    fEnded = END;
    pos = n;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let start = i;
    let parts = null; // slices and replacements, when the field holds "" or a CR
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        // '"'
        if (text.charCodeAt(i + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(start, i), '"');
          i += 2;
          start = i;
          continue;
        }
        // The closing quote.
        let value;
        if (parts === null) {
          value = text.slice(start, i);
        } else {
          parts.push(text.slice(start, i));
          value = parts.join('');
        }
        pos = i + 1;
        if (pos >= n) {
          fValue = value;
          fEnded = END;
          return;
        }
        const d = text.charCodeAt(pos);
        if (d === 44) {
          pos += 1;
          fValue = value;
          fEnded = COMMA;
          return;
        }
        if (d === 10) {
          pos += 1;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          return;
        }
        if (d === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          return;
        }
        // What follows the closing quote is appended as it stands, up to the next comma or line break.
        readUnquoted(value);
        if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        return;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(start, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        start = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
    pos = open + 1;
    line = openLine;
    errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
    readUnquoted('"');
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? columns ?? [] : null, rows, errors };
}
