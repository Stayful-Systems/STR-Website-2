// Parse a pasted Google Sheets link into the spreadsheet id and (optional) tab gid.
// Strict: https only, host exactly docs.google.com, path /spreadsheets/d/<id>[/...].
// Anything else (other hosts, http, lookalikes, other Google paths) is rejected.

export type SheetLink = { spreadsheetId: string; gid: number | null };

const ID_RE = /^[A-Za-z0-9_-]{20,120}$/;

export function parseSheetLink(input: string): SheetLink | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname !== 'docs.google.com') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  const m = /^\/spreadsheets\/d\/([^/]+)(?:\/[^/]*)?\/?$/.exec(url.pathname);
  if (!m) return null;
  const spreadsheetId = m[1];
  if (!ID_RE.test(spreadsheetId)) return null;
  return { spreadsheetId, gid: readGid(url) };
}

function readGid(url: URL): number | null {
  const fromQuery = url.searchParams.get('gid');
  let candidate = fromQuery;
  if (candidate === null) {
    // Fragment forms: #gid=123 or #gid=123&range=A1
    const frag = url.hash.replace(/^#/, '');
    for (const part of frag.split('&')) {
      const [k, v] = part.split('=');
      if (k === 'gid' && v !== undefined) {
        candidate = v;
        break;
      }
    }
  }
  if (candidate === null || !/^\d{1,12}$/.test(candidate)) return null;
  return Number(candidate);
}
