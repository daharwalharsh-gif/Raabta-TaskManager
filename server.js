require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const nodemailer = require('nodemailer');
const cookieParser = require('cookie-parser');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'taskmanager_secret_2026';
const SHEET_ID = process.env.SHEET_ID || '1SlUOgq1QN70tbIdlNat_XEY4JYGHG3JQyyh3NBG_lYQ';

app.use(cookieParser());
// Base64 payload asli file se ~33% bada hota hai, isliye 15 MB ki FMS upload
// limit ke liye body limit 30mb rakhi hai (report attachments bhi isi se jaate).
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));
// Har request par reminder slot check (minute me ek baar) — app so kar uthe to
// bhi missed reminder chala jaata hai, bina kisi bahri cron ke.
app.use((req, res, next) => waRequestHook(req, res, next));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// GOOGLE SHEETS DB LAYER
// ══════════════════════════════════════════════════════
// Retry wrapper for Google Sheets API calls (handles quota exceeded)
async function withRetry(fn, maxRetries = 5) {
  let delay = 2000; // start at 2s for quota errors
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isQuota = err.message && (
        err.message.includes('Quota exceeded') ||
        err.message.includes('RESOURCE_EXHAUSTED') ||
        err.message.includes('rateLimitExceeded') ||
        (err.code === 429)
      );
      if (isQuota && i < maxRetries) {
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000); // cap at 30s
      } else {
        throw err;
      }
    }
  }
}

class SheetDB {
  constructor(sheets, spreadsheetId) {
    this.sheets = sheets;
    this.spreadsheetId = spreadsheetId;
    this._cache = {};       // { tabName: { data:[], ts:0 } }
    this._hdrCache = {};    // { tabName: string[] }  — headers never change
    this._sheetIdCache = {}; // { tabName: sheetId }
    this._inflight = {};    // promise coalescing: { tabName: Promise }
    this.TTL = 90000;       // 90 sec cache — halves quota usage
  }

  _invalidate(tabName) {
    delete this._cache[tabName];
  }

  async getHeaders(tabName) {
    if (this._hdrCache[tabName]) return this._hdrCache[tabName];
    const res = await withRetry(() => this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!1:1`
    }));
    const headers = (res.data.values && res.data.values[0]) ? res.data.values[0] : [];
    this._hdrCache[tabName] = headers;
    return headers;
  }

  async findAll(tabName) {
    const cached = this._cache[tabName];
    if (cached && (Date.now() - cached.ts) < this.TTL) return cached.data;

    // Promise coalescing: if fetch already in progress for this tab, wait for it
    if (this._inflight[tabName]) return this._inflight[tabName];

    const fetchPromise = (async () => {
      const res = await withRetry(() => this.sheets.spreadsheets.values.get({
        spreadsheetId: this.spreadsheetId,
        range: `${tabName}!A:Z`
      }));
      const rows = res.data.values || [];
      let data = [];
      if (rows.length >= 2) {
        const headers = rows[0];
        this._hdrCache[tabName] = headers;
        data = rows.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? row[i] : ''; });
          return obj;
        });
      }
      this._cache[tabName] = { data, ts: Date.now() };
      return data;
    })();

    this._inflight[tabName] = fetchPromise;
    try {
      return await fetchPromise;
    } finally {
      delete this._inflight[tabName];
    }
  }

  async findWhere(tabName, filter) {
    const all = await this.findAll(tabName);
    return all.filter(row =>
      Object.keys(filter).every(key =>
        String(row[key] || '').trim() === String(filter[key] || '').trim()
      )
    );
  }

  async findOne(tabName, filter) {
    return (await this.findWhere(tabName, filter))[0] || null;
  }

  async insert(tabName, data) {
    const headers = await this.getHeaders(tabName);
    const all = await this.findAll(tabName); // uses cache
    let maxId = 0;
    for (const row of all) { const rid = parseInt(row.id) || 0; if (rid > maxId) maxId = rid; }
    data.id = String(maxId + 1);
    const rowValues = headers.map(h => (data[h] != null) ? String(data[h]) : '');
    await withRetry(() => this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [rowValues] }
    }));
    this._invalidate(tabName); // clear cache after write
    return data;
  }

  // Insert many rows in a single API call — avoids per-row quota hits
  async batchInsert(tabName, rows) {
    if (!rows || !rows.length) return [];
    const headers = await this.getHeaders(tabName);
    const all = await this.findAll(tabName); // uses cache for max-id lookup
    let maxId = 0;
    for (const row of all) { const rid = parseInt(row.id) || 0; if (rid > maxId) maxId = rid; }
    const rowValues = rows.map((data, i) => {
      data.id = String(maxId + 1 + i);
      return headers.map(h => (data[h] != null) ? String(data[h]) : '');
    });
    await withRetry(() => this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A:A`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rowValues }
    }));
    this._invalidate(tabName);
    return rows;
  }

  async _findRowIndex(tabName, id) {
    // Use cached data if available to avoid extra API call
    const cached = this._cache[tabName];
    if (cached && (Date.now() - cached.ts) < this.TTL) {
      const idx = cached.data.findIndex(r => String(r.id || '').trim() === String(id).trim());
      if (idx >= 0) return idx + 2; // +1 for header row, +1 for 1-based
    }
    const res = await withRetry(() => this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A:A`
    }));
    const col = res.data.values || [];
    for (let i = 1; i < col.length; i++) {
      if (String((col[i] && col[i][0]) || '').trim() === String(id).trim()) return i + 1;
    }
    return -1;
  }

  async _getSheetId(tabName) {
    if (this._sheetIdCache[tabName]) return this._sheetIdCache[tabName];
    const res = await withRetry(() => this.sheets.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: 'sheets(properties(title,sheetId))'
    }));
    for (const s of (res.data.sheets || [])) {
      this._sheetIdCache[s.properties.title] = s.properties.sheetId;
    }
    return this._sheetIdCache[tabName];
  }

  async update(tabName, id, data) {
    const headers = await this.getHeaders(tabName);
    const sheetRowNum = await this._findRowIndex(tabName, id);
    if (sheetRowNum < 0) throw new Error(`Row id=${id} not found in ${tabName}`);

    // Get current row values to merge
    const res = await withRetry(() => this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A${sheetRowNum}:Z${sheetRowNum}`
    }));
    const currentVals = (res.data.values && res.data.values[0]) ? res.data.values[0] : [];
    const updatedRow = headers.map((h, i) => {
      if (data[h] !== undefined && data[h] !== null) return String(data[h]);
      return currentVals[i] !== undefined ? currentVals[i] : '';
    });
    await withRetry(() => this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A${sheetRowNum}:${String.fromCharCode(64 + headers.length)}${sheetRowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [updatedRow] }
    }));
    this._invalidate(tabName); // clear cache after write
    const obj = {};
    headers.forEach((h, i) => { obj[h] = updatedRow[i]; });
    return obj;
  }

  async delete(tabName, id) {
    const sheetId = await this._getSheetId(tabName);
    if (sheetId == null) throw new Error(`Tab ${tabName} not found`);
    const sheetRowNum = await this._findRowIndex(tabName, id);
    if (sheetRowNum < 0) throw new Error(`Row id=${id} not found in ${tabName}`);
    await withRetry(() => this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: sheetRowNum - 1, endIndex: sheetRowNum }
          }
        }]
      }
    }));
    this._invalidate(tabName); // clear cache after delete
  }

  // Delete many rows by id in a single batchUpdate API call
  async batchDeleteByIds(tabName, ids) {
    if (!ids || !ids.length) return;
    const sheetId = await this._getSheetId(tabName);
    if (sheetId == null) throw new Error(`Tab ${tabName} not found`);
    // Read col A once to resolve all row indices
    const res = await withRetry(() => this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${tabName}!A:A`
    }));
    const col = res.data.values || [];
    const idSet = new Set(ids.map(String));
    const rowNums = []; // 1-based sheet rows
    for (let i = 1; i < col.length; i++) {
      const cellId = String((col[i] && col[i][0]) || '').trim();
      if (idSet.has(cellId)) rowNums.push(i + 1); // +1 because row 1 is header
    }
    if (!rowNums.length) { this._invalidate(tabName); return; }
    // Sort descending so deleting lower rows doesn't shift higher rows
    rowNums.sort((a, b) => b - a);
    await withRetry(() => this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: rowNums.map(rowNum => ({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum }
          }
        }))
      }
    }));
    this._invalidate(tabName);
  }
}

// ── Google service-account credentials loader ──
// Robust against various hosting panels (Hostinger/Vercel/etc.) that mangle
// long JSON env values: surrounding quotes, double-escaping, or base64.
function loadGoogleCreds() {
  // 1. Preferred: base64-encoded JSON (no special chars → never mangled on import)
  const b64 = process.env.GOOGLE_CREDENTIALS_B64;
  if (b64 && b64.trim()) {
    return JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  }

  let raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw || !raw.trim()) return require('./credentials.json');
  raw = raw.trim();

  // Strip a single layer of surrounding quotes some panels add
  if ((raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1);
  }

  // 2. Plain JSON
  try { return JSON.parse(raw); } catch (e) { /* fall through */ }

  // 3. Looks base64 (doesn't start with `{`) → decode then parse
  if (!raw.startsWith('{')) {
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8').trim();
      if (decoded.startsWith('{')) return JSON.parse(decoded);
    } catch (e) { /* fall through */ }
  }

  // 4. Over-escaped (e.g. `\{"type\":...` or `\\n` in key) → remove one backslash layer
  try { return JSON.parse(raw.replace(/\\(.)/g, '$1')); } catch (e) { /* fall through */ }

  throw new Error('GOOGLE_CREDENTIALS is set but could not be parsed as JSON/base64. ' +
    'Tip: use GOOGLE_CREDENTIALS_B64 with a base64-encoded service-account JSON.');
}

// ── Sheets client (singleton) ──
let _sheetsClient = null;
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const creds = loadGoogleCreds();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  _sheetsClient = google.sheets({ version: 'v4', auth: client });
  return _sheetsClient;
}

// ══════════════════════════════════════════════════════
// MYSQL DB LAYER — drop-in replacement for SheetDB
// ══════════════════════════════════════════════════════
// Exposes the exact same surface (findAll/findWhere/findOne/insert/
// batchInsert/update/delete/batchDeleteByIds/getHeaders/_invalidate) so the
// rest of the app is unchanged. `.sheets` keeps the Google client available
// for the FMS feature (which reads users' external spreadsheets).
// All values are returned as strings to match SheetDB behaviour exactly.
class MySqlDB {
  constructor(pool, sheetsClient) {
    this.pool = pool;
    this.sheets = sheetsClient;
    this._cache = {};       // { table: { data, ts } }
    this._hdrCache = {};    // { table: string[] }
    this._colsCache = {};   // { table: Set<colName> }
    this.TTL = parseInt(process.env.DB_CACHE_TTL_MS, 10) || 2000;   // short cache to coalesce repeat reads within a request (local test par .env se lamba)
  }

  _invalidate(table) { delete this._cache[table]; }

  async _columns(table) {
    if (this._colsCache[table]) return this._colsCache[table];
    const [rows] = await this.pool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
      [table]);
    const cols = rows.map(r => r.COLUMN_NAME);
    if (!cols.length) throw new Error(`Table not found: ${table}`);
    this._hdrCache[table] = cols;
    this._colsCache[table] = new Set(cols);
    return this._colsCache[table];
  }

  async getHeaders(table) {
    if (this._hdrCache[table]) return this._hdrCache[table];
    await this._columns(table);
    return this._hdrCache[table];
  }

  _stringifyRow(row) {
    const obj = {};
    for (const k of Object.keys(row)) {
      const v = row[k];
      obj[k] = (v === null || v === undefined) ? ''
        : (v instanceof Date ? v.toISOString() : String(v));
    }
    return obj;
  }

  async findAll(table) {
    const c = this._cache[table];
    if (c && (Date.now() - c.ts) < this.TTL) return c.data;
    const [rows] = await this.pool.query('SELECT * FROM `' + table + '` ORDER BY id ASC');
    const data = rows.map(r => this._stringifyRow(r));
    this._cache[table] = { data, ts: Date.now() };
    return data;
  }

  async findWhere(table, filter) {
    const all = await this.findAll(table);
    return all.filter(row =>
      Object.keys(filter).every(key =>
        String(row[key] || '').trim() === String(filter[key] || '').trim()));
  }

  async findOne(table, filter) {
    return (await this.findWhere(table, filter))[0] || null;
  }

  async insert(table, data) {
    const cols = await this._columns(table);
    const keys = Object.keys(data).filter(k => k !== 'id' && cols.has(k));
    let insertId;
    if (keys.length) {
      const colList = keys.map(k => '`' + k + '`').join(', ');
      const placeholders = keys.map(() => '?').join(', ');
      const vals = keys.map(k => (data[k] == null) ? null : String(data[k]));
      const [res] = await this.pool.query(
        'INSERT INTO `' + table + '` (' + colList + ') VALUES (' + placeholders + ')', vals);
      insertId = res.insertId;
    } else {
      const [res] = await this.pool.query('INSERT INTO `' + table + '` () VALUES ()');
      insertId = res.insertId;
    }
    this._invalidate(table);
    data.id = String(insertId);
    return data;
  }

  async batchInsert(table, rows) {
    if (!rows || !rows.length) return [];
    const cols = await this._columns(table);
    const keySet = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (k !== 'id' && cols.has(k)) keySet.add(k);
    const keys = [...keySet];
    if (!keys.length) { for (const r of rows) await this.insert(table, r); return rows; }
    const colList = keys.map(k => '`' + k + '`').join(', ');
    const values = rows.map(r => keys.map(k => (r[k] == null) ? null : String(r[k])));
    const [res] = await this.pool.query(
      'INSERT INTO `' + table + '` (' + colList + ') VALUES ?', [values]);
    const first = res.insertId;
    rows.forEach((r, i) => { r.id = String(first + i); });
    this._invalidate(table);
    return rows;
  }

  async update(table, id, data) {
    const cols = await this._columns(table);
    const keys = Object.keys(data).filter(k => k !== 'id' && cols.has(k));
    if (keys.length) {
      const setClause = keys.map(k => '`' + k + '` = ?').join(', ');
      const vals = keys.map(k => (data[k] == null) ? null : String(data[k]));
      vals.push(String(id));
      await this.pool.query('UPDATE `' + table + '` SET ' + setClause + ' WHERE id = ?', vals);
    }
    this._invalidate(table);
    const [rows] = await this.pool.query('SELECT * FROM `' + table + '` WHERE id = ? LIMIT 1', [String(id)]);
    return rows.length ? this._stringifyRow(rows[0]) : { ...data, id: String(id) };
  }

  async delete(table, id) {
    await this.pool.query('DELETE FROM `' + table + '` WHERE id = ?', [String(id)]);
    this._invalidate(table);
  }

  async batchDeleteByIds(table, ids) {
    if (!ids || !ids.length) return;
    const placeholders = ids.map(() => '?').join(', ');
    await this.pool.query('DELETE FROM `' + table + '` WHERE id IN (' + placeholders + ')', ids.map(String));
    this._invalidate(table);
  }
}

// ══════════════════════════════════════════════════════
// MYSQL SCHEMA (single source of truth) + auto-migration
// ══════════════════════════════════════════════════════
// Add a table or a column here and it is created automatically on the next
// deploy — no manual SQL needed. `id INT AUTO_INCREMENT PRIMARY KEY` is added
// to every table implicitly. TEXT/LONGTEXT columns omit DEFAULT (MySQL rule).
const MYSQL_SCHEMA = {
  Users: {
    name: "VARCHAR(255) DEFAULT ''", email: "VARCHAR(255) DEFAULT ''",
    notification_email: "VARCHAR(255) DEFAULT ''", password: "VARCHAR(255) DEFAULT ''",
    role: "VARCHAR(50) DEFAULT 'user'", phone: "VARCHAR(50) DEFAULT ''",
    department: "VARCHAR(255) DEFAULT ''", week_off: "VARCHAR(50) DEFAULT ''",
    extra_off: "TEXT", profile_image: "LONGTEXT", created_at: "VARCHAR(40) DEFAULT ''"
  },
  Delegation_Tasks: {
    description: "TEXT", assigned_to: "VARCHAR(20) DEFAULT ''", assigned_by: "VARCHAR(20) DEFAULT ''",
    due_date: "VARCHAR(40) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    priority: "VARCHAR(20) DEFAULT 'low'", approval: "VARCHAR(10) DEFAULT 'no'",
    waiting_approval: "VARCHAR(5) DEFAULT '0'", remarks: "TEXT", frequency: "VARCHAR(20) DEFAULT ''",
    last_reminder_date: "VARCHAR(40) DEFAULT ''", created_at: "VARCHAR(40) DEFAULT ''",
    attachments: "LONGTEXT", report_note: "TEXT",
    was_reported: "VARCHAR(5) DEFAULT '0'",
    // 12 Sep 2026: Harsh ne poochha "task auto Done kyun ho gaya, kisne kiya?"
    // -- aur DB me iska koi record tha hi nahi. Ab har status-badlav ke saath
    // ye teen likhe jaate hain, taaki agli baar jawab ginti se mile.
    status_changed_at: "VARCHAR(40) DEFAULT ''",
    status_changed_by: "VARCHAR(20) DEFAULT ''",
    status_changed_by_name: "VARCHAR(120) DEFAULT ''"
  },
  Checklist_Tasks: {
    description: "TEXT", assigned_to: "VARCHAR(20) DEFAULT ''", assigned_by: "VARCHAR(20) DEFAULT ''",
    due_date: "VARCHAR(40) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    priority: "VARCHAR(20) DEFAULT 'low'", remarks: "TEXT", frequency: "VARCHAR(20) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''",
    status_changed_at: "VARCHAR(40) DEFAULT ''",
    status_changed_by: "VARCHAR(20) DEFAULT ''",
    status_changed_by_name: "VARCHAR(120) DEFAULT ''",
    // Sirf DB me padhne ki aasani ke liye (Harsh, 1 Sep): assigned_to me ID
    // hoti hai (13, 24...) jise dekh kar pata nahi chalta kaun hai. Ye column
    // usi bande ka NAAM rakhta hai. App kahin ise padhta nahi — assigned_to
    // hi asli hai; ye sirf phpMyAdmin me nazar daalne ke liye hai.
    doer_name: "VARCHAR(120) DEFAULT ''"
  },
  Task_Approvals: {
    task_id: "VARCHAR(20) DEFAULT ''", task_type: "VARCHAR(20) DEFAULT ''",
    requested_by: "VARCHAR(20) DEFAULT ''", requested_to: "VARCHAR(20) DEFAULT ''",
    action_type: "VARCHAR(20) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    note: "TEXT", created_at: "VARCHAR(40) DEFAULT ''"
  },
  // Status ka poora safar. status_changed_* columns me sirf AAKHRI badlav
  // rehta hai -- agla badlav pichhle ko mita deta hai. Isliye "pending se
  // done kisne kiya" ka jawab nahi milta tha, kyunki uske baad kisi ne close
  // kiya to wahi naam upar chadh jaata tha. Ab har badlav alag row banta hai.
  // (Harsh, 17 Sep 2026)
  Task_Status_Log: {
    task_id: "VARCHAR(20) DEFAULT ''", task_type: "VARCHAR(20) DEFAULT ''",
    from_status: "VARCHAR(20) DEFAULT ''", to_status: "VARCHAR(20) DEFAULT ''",
    by_user: "VARCHAR(20) DEFAULT ''", by_name: "VARCHAR(120) DEFAULT ''",
    changed_at: "VARCHAR(40) DEFAULT ''"
  },
  // Chhuttiyan. 16 Sep 2026 tak ye browser ke localStorage me padi thin,
  // isliye jo bhi add karta wo SIRF USI ke browser me dikhti thi -- kisi
  // doosre bande ko, ya usi bande ko doosre phone par, kuch nahi dikhta tha.
  // Harsh: "sabhi ko show honi chahiye." Isliye ab DB me.
  Holidays: {
    date: "VARCHAR(20) DEFAULT ''",        // YYYY-MM-DD
    name: "VARCHAR(160) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  Task_Comments: {
    task_id: "VARCHAR(20) DEFAULT ''", task_type: "VARCHAR(20) DEFAULT ''",
    user_id: "VARCHAR(20) DEFAULT ''", comment: "TEXT", created_at: "VARCHAR(40) DEFAULT ''"
  },
  Task_Transfers: {
    task_id: "VARCHAR(20) DEFAULT ''", task_type: "VARCHAR(20) DEFAULT ''",
    from_user: "VARCHAR(20) DEFAULT ''", to_user: "VARCHAR(20) DEFAULT ''",
    requested_by: "VARCHAR(20) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    note: "TEXT", created_at: "VARCHAR(40) DEFAULT ''"
  },
  Week_Plans: {
    employee_id: "VARCHAR(20) DEFAULT ''", hod_id: "VARCHAR(20) DEFAULT ''",
    start_date: "VARCHAR(40) DEFAULT ''", target_count: "VARCHAR(20) DEFAULT '0'",
    improvement_pct: "VARCHAR(20) DEFAULT ''", created_at: "VARCHAR(40) DEFAULT ''",
    updated_at: "VARCHAR(40) DEFAULT ''"
  },
  FMS_Config: {
    fms_name: "VARCHAR(255) DEFAULT ''", sheet_name: "VARCHAR(255) DEFAULT ''",
    sheet_id: "VARCHAR(255) DEFAULT ''", header_row: "VARCHAR(10) DEFAULT '1'",
    total_steps: "VARCHAR(10) DEFAULT '1'", steps_json: "TEXT", created_at: "VARCHAR(40) DEFAULT ''"
  },
  Leave_Requests: {
    user_id: "VARCHAR(20) DEFAULT ''", from_date: "VARCHAR(40) DEFAULT ''",
    to_date: "VARCHAR(40) DEFAULT ''", reason: "TEXT",
    status: "VARCHAR(20) DEFAULT 'pending'", note: "TEXT", created_at: "VARCHAR(40) DEFAULT ''"
  },
  // WhatsApp outbox — assign-time messages pehle yahan likhe jaate hain, phir
  // bheje jaate hain. Fail ho ya app restart ho jaye to agla tick dobara
  // koshish karta hai — isliye koi message chupchap gum nahi hota.
  WA_Outbox: {
    phone: "VARCHAR(30) DEFAULT ''", message: "TEXT",
    kind: "VARCHAR(30) DEFAULT ''", ref: "VARCHAR(60) DEFAULT ''",
    person: "VARCHAR(120) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    attempts: "VARCHAR(10) DEFAULT '0'", last_error: "TEXT",
    revivals: "VARCHAR(10) DEFAULT '0'",
    posts: "VARCHAR(10) DEFAULT '0'",
    created_at: "VARCHAR(40) DEFAULT ''", sent_at: "VARCHAR(40) DEFAULT ''"
  },
  // FMS auto-notifications — "jab is column me ye likha ho to us bande ko
  // WhatsApp bhejo". Rules yahan, aur kis row par bhej chuke wo Log me.
  FMS_Notify_Rules: {
    fms_id: "VARCHAR(20) DEFAULT ''", watch_col: "VARCHAR(10) DEFAULT ''",
    match_value: "VARCHAR(120) DEFAULT ''", person: "VARCHAR(120) DEFAULT ''",
    phone: "VARCHAR(30) DEFAULT ''", message: "TEXT",
    bill_col: "VARCHAR(10) DEFAULT 'D'",
    person_col: "VARCHAR(10) DEFAULT ''",
    enabled: "VARCHAR(5) DEFAULT '1'", created_at: "VARCHAR(40) DEFAULT ''"
  },
  FMS_Notify_Log: {
    rule_id: "VARCHAR(20) DEFAULT ''", sheet_row: "VARCHAR(20) DEFAULT ''",
    phone: "VARCHAR(30) DEFAULT ''", sent_at: "VARCHAR(40) DEFAULT ''"
  },
  // HR Reporting — biometric machine ke "Exception Statistic Report" Excel se
  // aayi attendance rows. location = store | office | karigar.
  HR_Attendance: {
    location: "VARCHAR(20) DEFAULT ''", emp_id: "VARCHAR(20) DEFAULT ''",
    emp_name: "VARCHAR(120) DEFAULT ''", department: "VARCHAR(120) DEFAULT ''",
    att_date: "VARCHAR(20) DEFAULT ''", punch_in: "VARCHAR(10) DEFAULT ''",
    punch_out: "VARCHAR(10) DEFAULT ''", punch_in2: "VARCHAR(10) DEFAULT ''",
    punch_out2: "VARCHAR(10) DEFAULT ''", late_min: "VARCHAR(10) DEFAULT '0'",
    early_min: "VARCHAR(10) DEFAULT '0'", absence_min: "VARCHAR(10) DEFAULT '0'",
    total_min: "VARCHAR(10) DEFAULT '0'", note: "TEXT",
    manual: "VARCHAR(5) DEFAULT '0'", uploaded_by: "VARCHAR(20) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  // FMS extra-input me upload hui files (image/PDF/video) — file DB me base64
  // rehti hai, sheet me sirf uska link jaata hai.
  FMS_Uploads: {
    fms_id: "VARCHAR(20) DEFAULT ''", step_id: "VARCHAR(20) DEFAULT ''",
    row_index: "VARCHAR(20) DEFAULT ''", col_letter: "VARCHAR(10) DEFAULT ''",
    file_name: "VARCHAR(255) DEFAULT ''", mime_type: "VARCHAR(120) DEFAULT ''",
    file_size: "VARCHAR(20) DEFAULT '0'", file_data: "LONGTEXT",
    uploaded_by: "VARCHAR(20) DEFAULT ''", created_at: "VARCHAR(40) DEFAULT ''"
  },
  // Chhoti key-value table — abhi WhatsApp reminder ke "aaj is slot ka pass ho
  // chuka" marker ke liye. App restart hone par bhi yaad rehta hai, isliye
  // logon ko duplicate reminder nahi jaate.
  // HR Reporting = Employee Onboarding FMS (Harsh, 22 Oct). Ek row = ek naya joinee
  // ("Employee master form" ki entry).
  HR_Onboarding: {
    name: "VARCHAR(150) DEFAULT ''",
    designation: "VARCHAR(150) DEFAULT ''",
    phone: "VARCHAR(40) DEFAULT ''",
    // Step 1 "Data Inputs" (Harsh, 22 Oct): candidate ki details. Resume /
    // portfolio / intro video ki file HR_Onboarding_Files me, link yahan.
    email: "VARCHAR(150) DEFAULT ''",
    ref_by: "VARCHAR(150) DEFAULT ''",            // Ref. by -- kisne refer kiya (entry form)
    resume_link: "VARCHAR(500) DEFAULT ''",
    portfolio_link: "VARCHAR(500) DEFAULT ''",
    video_link: "VARCHAR(500) DEFAULT ''",
    interview: "VARCHAR(20) DEFAULT ''",          // '' / selected (Approved) / rejected -- Step 2 Director Review
    locked: "VARCHAR(2) DEFAULT '0'",             // 1 = Step 3 complete, details lock (Unlock se khulti)
    lock_note: "VARCHAR(300) DEFAULT ''",         // "Unlocked by X: wajah"
    alt_phone: "VARCHAR(40) DEFAULT ''",
    alt_phone_na: "VARCHAR(2) DEFAULT '0'",       // 1 = alternate number nahi hai
    salary: "VARCHAR(40) DEFAULT ''",
    location: "VARCHAR(80) DEFAULT 'Delhi'",      // step 10, 11 ke doer isi se
    dob: "VARCHAR(20) DEFAULT ''",                // YYYY-MM-DD (step 14 birthday)
    joining_date: "VARCHAR(20) DEFAULT ''",       // YYYY-MM-DD -- har step ki plan date isi se
    esis: "VARCHAR(60) DEFAULT ''",               // yes / no / haath se likha -- no ho to step 20 N/A
    contract: "VARCHAR(60) DEFAULT ''",           // yes / no / haath se likha
    docs_collected: "VARCHAR(60) DEFAULT ''",     // Step 3: documents collected? yes / no (file HR_Onboarding_Files me, kind documents)
    is_sales: "VARCHAR(5) DEFAULT 'no'",          // designation me "sales" -> step 17 lagu
    probation_days: "VARCHAR(10) DEFAULT '90'",   // step 20 = joining + itne din
    status: "VARCHAR(20) DEFAULT 'active'",       // active / cancelled / rejected
    notes: "TEXT",
    created_by: "VARCHAR(20) DEFAULT ''",
    created_by_name: "VARCHAR(120) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''",
    updated_at: "VARCHAR(40) DEFAULT ''"
  },
  // Har badlaav ka hisaab -- entry, edit, unlock / lock, step, file: kaun, kab, kya
  HR_Onboarding_Audit: {
    onboarding_id: "VARCHAR(20) DEFAULT ''",
    action: "VARCHAR(30) DEFAULT ''",
    details: "TEXT",
    by_id: "VARCHAR(20) DEFAULT ''",
    by_name: "VARCHAR(120) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  // Candidate ki files (resume / portfolio / intro video) -- list me data nahi bhejte.
  // Nayi file tukdon me (HR_Onboarding_Chunks); purani chhoti file file_data me.
  HR_Onboarding_Files: {
    onboarding_id: "VARCHAR(20) DEFAULT ''",
    kind: "VARCHAR(20) DEFAULT ''",               // resume / portfolio / video
    file_name: "VARCHAR(255) DEFAULT ''",
    mime_type: "VARCHAR(120) DEFAULT ''",
    file_size: "VARCHAR(20) DEFAULT '0'",
    file_data: "LONGTEXT",
    complete: "VARCHAR(2) DEFAULT '1'",           // 0 = upload abhi chal rahi / adhoori chhodi
    chunks: "VARCHAR(10) DEFAULT '0'",            // kitne tukde (0 = purani, file_data me)
    uploaded_by: "VARCHAR(20) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  // Badi file ke tukde (base64, ~4 MB file ka ek tukda) -- seq 0, 1, 2...
  HR_Onboarding_Chunks: {
    file_id: "VARCHAR(20) DEFAULT ''",
    seq: "VARCHAR(10) DEFAULT ''",
    chunk_data: "LONGTEXT"
  },
  // Har joinee ke 20 step -- kaun doer, Done hua ya nahi, kab, kisne
  HR_Onboarding_Steps: {
    onboarding_id: "VARCHAR(20) DEFAULT ''",
    step_no: "VARCHAR(5) DEFAULT ''",
    doer_id: "VARCHAR(20) DEFAULT ''",
    doer_name: "VARCHAR(120) DEFAULT ''",         // haath se likha naam (app me account na ho)
    done: "VARCHAR(2) DEFAULT '0'",
    done_at: "VARCHAR(40) DEFAULT ''",
    done_by: "VARCHAR(20) DEFAULT ''",
    done_by_name: "VARCHAR(120) DEFAULT ''",
    note: "TEXT",
    na: "VARCHAR(2) DEFAULT '0'",                 // 1 = is joinee par lagu nahi
    checklist: "TEXT",                            // Complete Task ki checklist: JSON { itemId: { at, by, byName } }
    updated_at: "VARCHAR(40) DEFAULT ''"
  },
  // Workflow tab: har step ka default doer (step 10, 11 me location ke hisaab se)
  HR_Onboarding_Owners: {
    step_no: "VARCHAR(5) DEFAULT ''",
    location: "VARCHAR(80) DEFAULT ''",
    doer_id: "VARCHAR(20) DEFAULT ''",
    doer_name: "VARCHAR(120) DEFAULT ''",
    tat_days: "VARCHAR(10) DEFAULT ''",           // Step Admin: step kitne din me (khali = PDF ki timeline)
    updated_at: "VARCHAR(40) DEFAULT ''"
  },
  App_State: {
    key_name: "VARCHAR(120) DEFAULT ''", value: "TEXT", updated_at: "VARCHAR(40) DEFAULT ''"
  },
  // MAINTENANCE — Ashok kumar ke "Office Cash" wale amount ka hisaab.
  // Aana (credit) Purchase_System sheet se apne aap padha jaata hai; ye table
  // sirf KHARCH (debit) rakhti hai — kahan lagaya, kitna, aur bill/photo.
  Maintenance_Expenses: {
    spent_on: "VARCHAR(20) DEFAULT ''",        // kis din kharch hua (YYYY-MM-DD)
    amount: "VARCHAR(20) DEFAULT '0'",
      // Kiske naam par (Bappi ji / Bajji ji), ya khali.
    person: "VARCHAR(120) DEFAULT ''",
    // '' (khali) = Maintenance se nikla. Balance se ghatta hai. Naam ho to
    //              Maintenance 2 me us bande ka "Received" ban jaata hai.
    // 'm2'       = Maintenance 2 se nikla — us bande ke apne paise me se.
    //              Main balance se DOBARA nahi ghatta (ek baar ghat chuka).
    ledger: "VARCHAR(10) DEFAULT ''",
    description: "TEXT",                        // kahan lagaya
    image_name: "VARCHAR(255) DEFAULT ''",
    image_type: "VARCHAR(120) DEFAULT ''",
    image_data: "LONGTEXT",                     // bill/photo base64 (optional)
    created_by: "VARCHAR(20) DEFAULT ''",
    created_by_name: "VARCHAR(120) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },

  // ── GOLD SYSTEM (Harsh, 13 Oct) ──────────────────────────────────
  // Do alag khaate, dhaancha bilkul ek jaisa: Gold Stock aur Gold Wire
  // Stock. Har row ek entry hai -- IN (aaya) ya OUT (gaya). Weight gram me
  // rakhte hain, aur balance = sab IN ka jod minus sab OUT ka jod.
  Gold_Stock: {
    entry_type: "VARCHAR(5) DEFAULT 'IN'",      // IN = aaya, OUT = gaya
    entry_date: "VARCHAR(20) DEFAULT ''",       // YYYY-MM-DD
    weight: "VARCHAR(30) DEFAULT '0'",          // gram
    karat: "VARCHAR(30) DEFAULT ''",            // 24 Karat waghairah
    rate: "VARCHAR(30) DEFAULT ''",             // per gram
    vendor: "VARCHAR(200) DEFAULT ''",          // sirf OUT wali entry me
    to_karigar: "VARCHAR(5) DEFAULT ''",        // OUT: yes = karigar ko diya, no = seedha Total OUT
    remarks: "TEXT",
    image_name: "VARCHAR(255) DEFAULT ''",
    image_type: "VARCHAR(120) DEFAULT ''",
    image_data: "LONGTEXT",                     // photo base64 (optional)
    created_by: "VARCHAR(20) DEFAULT ''",
    created_by_name: "VARCHAR(120) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  // Silver ka khaata. Dhaancha wahi hai, par naam alag padte hain:
  //   karat  = Purity (92.5 / 999)
  //   vendor = IN me Vendor ka naam, OUT me Karigar ka naam
  Silver_Stock: {
    entry_type: "VARCHAR(5) DEFAULT 'IN'",      // IN = aaya, OUT = gaya
    entry_date: "VARCHAR(20) DEFAULT ''",       // YYYY-MM-DD
    weight: "VARCHAR(30) DEFAULT '0'",          // gram
    karat: "VARCHAR(30) DEFAULT ''",            // Purity -- 92.5 ya 999
    rate: "VARCHAR(30) DEFAULT ''",             // Silver me nahi poochhte, jagah rakhi hai
    vendor: "VARCHAR(200) DEFAULT ''",          // IN = Vendor, OUT = Karigar
    to_karigar: "VARCHAR(5) DEFAULT ''",        // OUT: yes = karigar ko diya, no = seedha Total OUT
    remarks: "TEXT",
    image_name: "VARCHAR(255) DEFAULT ''",
    image_type: "VARCHAR(120) DEFAULT ''",
    image_data: "LONGTEXT",
    created_by: "VARCHAR(20) DEFAULT ''",
    created_by_name: "VARCHAR(120) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  Gold_Wire_Stock: {
    entry_type: "VARCHAR(5) DEFAULT 'IN'",      // IN = aaya, OUT = gaya
    entry_date: "VARCHAR(20) DEFAULT ''",       // YYYY-MM-DD
    weight: "VARCHAR(30) DEFAULT '0'",          // gram
    karat: "VARCHAR(30) DEFAULT ''",            // 24 Karat waghairah
    rate: "VARCHAR(30) DEFAULT ''",             // per gram
    vendor: "VARCHAR(200) DEFAULT ''",          // sirf OUT wali entry me
    to_karigar: "VARCHAR(5) DEFAULT ''",        // OUT: yes = karigar ko diya, no = seedha Total OUT
    remarks: "TEXT",
    image_name: "VARCHAR(255) DEFAULT ''",
    image_type: "VARCHAR(120) DEFAULT ''",
    image_data: "LONGTEXT",                     // photo base64 (optional)
    created_by: "VARCHAR(20) DEFAULT ''",
    created_by_name: "VARCHAR(120) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  }
};

// Idempotent: creates missing tables and adds missing columns. Safe to run on
// every startup; never drops or alters existing data.
async function ensureMySqlSchema(pool) {
  let added = 0;
  for (const [table, cols] of Object.entries(MYSQL_SCHEMA)) {
    await pool.query('CREATE TABLE IF NOT EXISTS `' + table +
      '` (id INT AUTO_INCREMENT PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    const [existing] = await pool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    const have = new Set(existing.map(r => r.COLUMN_NAME));
    for (const [col, def] of Object.entries(cols)) {
      if (!have.has(col)) {
        await pool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + col + '` ' + def);
        console.log(`  schema: + ${table}.${col}`);
        added++;
      }
    }
  }
  console.log(added ? `  schema auto-migrate: ${added} column(s)/table(s) added` : '  schema up to date');
}

// Global db instance
let db = null;
let dbInitializationPromise = null;

async function initializeDatabase() {
  const driver = (process.env.DB_DRIVER || 'sheets').toLowerCase();

  if (driver === 'mysql') {
    // Google client is still needed for the FMS feature — load it but don't
    // fail MySQL startup if credentials are unavailable.
    let sheetsApi = null;
    try { sheetsApi = await getSheetsClient(); }
    catch (e) { console.log('  Google Sheets client unavailable — FMS features disabled:', e.message); }

    const mysql = require('mysql2/promise');
    const pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      dateStrings: true
    });
    await pool.query('SELECT 1');
    await ensureMySqlSchema(pool); // auto-create missing tables/columns
    db = new MySqlDB(pool, sheetsApi);
    console.log(`  MySQL DB connected (${process.env.DB_NAME})`);
  } else {
    const sheetsApi = await getSheetsClient();
    await withRetry(() => sheetsApi.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'spreadsheetId' }));
    db = new SheetDB(sheetsApi, SHEET_ID);
    console.log('  Google Sheets DB connected (with in-memory cache)');
  }

  try {
    await seedAdminIfNeeded();
  } catch(e) {
    console.log('  Seed skipped (will retry on next request):', e.message);
  }
  return db;
}

// Wait for db to be ready (handles Vercel cold-start race condition and lazy init)
async function getDB() {
  if (db) return db;
  if (!dbInitializationPromise) {
    dbInitializationPromise = initializeDatabase().catch(err => {
      dbInitializationPromise = null;
      throw err;
    });
  }
  return await dbInitializationPromise;
}

// deleteRow delegates to db.delete (which has cache invalidation built in)
async function deleteRow(tabName, id) {
  const d = await getDB();
  await d.delete(tabName, id);
}

// ══════════════════════════════════════════════════════
// EMAIL
// ══════════════════════════════════════════════════════
// Email notifications are OFF by default — WhatsApp is the only channel.
// Set EMAIL_ENABLED=true in .env to turn task emails back on.
const EMAIL_ENABLED = (process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';

const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  // Timeouts — warna SMTP atak jaye to request hamesha ke liye latki rehti hai
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000
});

// Harsh, 11 Sep 2026: "only mail Leave request / approval par hi jaye."
// Task assign aur daily reminder ki mail band. Isliye ab har mail ki ek
// KISM hoti hai, aur sirf is list wali jaati hain. Koi nayi mail likhe aur
// kism na de, to wo apne aap BAND rahegi — chup-chaap nikal nahi jayegi.
const MAIL_KINDS_ON = [
  'leave-request',    // employee ne leave maangi — HR ko
  'leave-decision',   // leave approve/reject hui — employee ko
  'test'              // admin ka test button (setup jaanchne ke liye)
];

// Status object wapas karta hai (diagnose ke liye) — throw kabhi nahi karta,
// taaki koi bhi mail fail ho to app ka flow na ruke.
async function sendMail(to, subject, html, kind) {
  if (!MAIL_KINDS_ON.includes(kind)) {
    return { skipped: 'is kism ki mail band hai: ' + (kind || 'bina-kism') };
  }
  if (!EMAIL_ENABLED) return { skipped: 'email-disabled', hint: '.env me EMAIL_ENABLED=true karo' };
  if (!to) return { skipped: 'no-recipient' };
  if (!process.env.SMTP_USER) return { skipped: 'smtp-not-configured', hint: '.env me SMTP_USER set nahi hai' };
  try {
    await mailTransporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Task Manager'}" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
    console.log(`  Email sent to ${to} — ${subject}`);
    return { ok: true };
  } catch (err) {
    console.error(`  Email failed (${to}):`, err.message);
    return { ok: false, error: err.message };
  }
}

async function getNotifyTarget(userId) {
  try {
    const user = await db.findOne('Users', { id: String(userId) });
    if (!user || !user.notification_email) return null;
    return { name: user.name, email: user.notification_email };
  } catch { return null; }
}

function delegationEmailHtml({ assigneeName, assignerName, desc, dueDate, priority, approval, remarks }) {
  const appUrl = process.env.APP_URL || '#';
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color:#1976d2;margin-top:0;">New Task Assigned to You</h2>
      <p>Hi <b>${assigneeName || 'there'}</b>,</p>
      <p><b>${assignerName || 'Someone'}</b> has assigned you a new delegation task:</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px;background:#f0f4f8;width:140px;"><b>Task</b></td><td style="padding:8px;">${desc}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Due Date</b></td><td style="padding:8px;">${dueDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Priority</b></td><td style="padding:8px;text-transform:capitalize;">${priority}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Approval Required</b></td><td style="padding:8px;text-transform:capitalize;">${approval}</td></tr>
        ${remarks ? `<tr><td style="padding:8px;background:#f0f4f8;"><b>Remarks</b></td><td style="padding:8px;">${remarks}</td></tr>` : ''}
      </table>
      <a href="${appUrl}" style="display:inline-block;background:#1976d2;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Open Task Manager</a>
    </div>
  </div>`;
}

function reminderEmailHtml(byUser, todayStr) {
  const appUrl = process.env.APP_URL || '#';
  const userNames = Object.keys(byUser);
  const totalTasks = userNames.reduce((s, n) => s + byUser[n].length, 0);
  const sections = userNames.map(name => {
    const tasks = byUser[name];
    const rows = tasks.map(t => {
      const isOverdue = t.due_date < todayStr;
      const dueLabel = isOverdue
        ? `<span style="color:#dc2626;font-weight:700">${t.due_date} Overdue</span>`
        : (t.due_date === todayStr ? `<span style="color:#d97706;font-weight:700">${t.due_date} (Today)</span>` : `<b>${t.due_date}</b>`);
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px">${t.description || '—'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:13px;white-space:nowrap">${dueLabel}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12px;text-transform:capitalize;color:#64748b">${t.priority || 'low'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eef2f7;font-size:12px;color:#64748b">${t.assignerName || '—'}</td>
      </tr>`;
    }).join('');
    return `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="font-weight:700;font-size:15px;color:#1e293b;margin-bottom:8px">${name} — ${tasks.length} pending task${tasks.length > 1 ? 's' : ''}</div>
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="background:#f1f5f9">
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b">Task</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b">Due Date</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b">Priority</th>
          <th style="padding:8px 10px;text-align:left;font-size:11px;color:#64748b">Assigned By</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');
  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:10px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
      <h2 style="color:#dc2626;margin:0 0 4px 0">Pending Task Reminder</h2>
      <p style="margin:0 0 18px 0;color:#475569;font-size:14px">Today: <b>${todayStr}</b> — tasks due within 2 days shown below.</p>
      ${sections}
      <a href="${appUrl}" style="display:inline-block;background:#1976d2;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-weight:600;margin-top:6px">Open Task Manager</a>
      <p style="color:#94a3b8;font-size:11px;margin-top:18px">Total <b>${totalTasks}</b> pending task${totalTasks > 1 ? 's' : ''}. Reminders sent daily at 12:00 PM until task is completed.</p>
    </div>
  </div>`;
}

// ── Leave request notification (employee → HR) ──
function leaveRequestEmailHtml({ employeeName, fromDate, toDate, days, reason }) {
  const appUrl = process.env.APP_URL || '#';
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color:#d97706;margin-top:0;">🏖️ New Leave Request</h2>
      <p><b>${employeeName || 'An employee'}</b> has submitted a leave request and is awaiting your review.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px;background:#f0f4f8;width:140px;"><b>Employee</b></td><td style="padding:8px;">${employeeName || '—'}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>From</b></td><td style="padding:8px;">${fromDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>To</b></td><td style="padding:8px;">${toDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Duration</b></td><td style="padding:8px;">${days} day${days > 1 ? 's' : ''}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Reason</b></td><td style="padding:8px;">${reason || '—'}</td></tr>
      </table>
      <a href="${appUrl}" style="display:inline-block;background:#d97706;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Review Request</a>
      <p style="color:#94a3b8;font-size:11px;margin-top:18px">Please approve or reject this request in the Raabta Task Manager.</p>
    </div>
  </div>`;
}

// ── Leave decision notification (HR → employee) ──
function leaveDecisionEmailHtml({ employeeName, fromDate, toDate, days, action, note, reviewerName }) {
  const appUrl = process.env.APP_URL || '#';
  const isApproved = action === 'approved';
  const color = isApproved ? '#16a34a' : '#dc2626';
  const icon = isApproved ? '✅' : '❌';
  const label = isApproved ? 'Approved' : 'Rejected';
  return `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f9fc;padding:20px;">
    <div style="background:#fff;border-radius:8px;padding:30px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
      <h2 style="color:${color};margin-top:0;">${icon} Your Leave Request has been ${label}</h2>
      <p>Hi <b>${employeeName || 'there'}</b>,</p>
      <p>Your leave request has been <b style="color:${color}">${label.toLowerCase()}</b>${reviewerName ? ` by <b>${reviewerName}</b>` : ''}.</p>
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px;background:#f0f4f8;width:140px;"><b>From</b></td><td style="padding:8px;">${fromDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>To</b></td><td style="padding:8px;">${toDate}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Duration</b></td><td style="padding:8px;">${days} day${days > 1 ? 's' : ''}</td></tr>
        <tr><td style="padding:8px;background:#f0f4f8;"><b>Status</b></td><td style="padding:8px;color:${color};font-weight:700">${label}</td></tr>
        ${note ? `<tr><td style="padding:8px;background:#f0f4f8;"><b>Note</b></td><td style="padding:8px;">${note}</td></tr>` : ''}
      </table>
      <a href="${appUrl}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;">Open Task Manager</a>
    </div>
  </div>`;
}

// ── Delegation reminders ──
async function runDelegationReminders() {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const cutoff = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const allTasks = await db.findAll('Delegation_Tasks');
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const tasks = allTasks.filter(t => {
      return t.status === 'pending' &&
        t.due_date && t.due_date <= cutoff &&
        (!t.last_reminder_date || t.last_reminder_date < todayStr);
    });

    if (!tasks.length) {
      console.log(`  Reminder pass @ ${todayStr}: 0 pending tasks in window`);
      return { sent: 0, skipped: 0 };
    }

    const groups = {};
    for (const t of tasks) {
      const assignee = userMap[String(t.assigned_to)];
      if (!assignee || !assignee.notification_email) continue;
      const email = assignee.notification_email.trim().toLowerCase();
      if (!email) continue;
      const assigner = userMap[String(t.assigned_by)];
      if (!groups[email]) groups[email] = { byUser: {}, taskIds: [] };
      if (!groups[email].byUser[assignee.name]) groups[email].byUser[assignee.name] = [];
      groups[email].byUser[assignee.name].push({ ...t, assignerName: assigner ? assigner.name : '—' });
      groups[email].taskIds.push(t.id);
    }

    let sent = 0, failed = 0;
    for (const email of Object.keys(groups)) {
      const { byUser, taskIds } = groups[email];
      const totalForEmail = taskIds.length;
      const userNames = Object.keys(byUser);
      const subject = userNames.length === 1
        ? `${totalForEmail} pending task${totalForEmail > 1 ? 's' : ''} for ${userNames[0]}`
        : `${totalForEmail} pending task${totalForEmail > 1 ? 's' : ''} (${userNames.length} users)`;
      try {
        // BAND (Harsh, 11 Sep): daily reminder sirf WhatsApp par jata hai
        await sendMail(email, subject, reminderEmailHtml(byUser, todayStr), 'daily-reminder');
        for (const tid of taskIds) {
          try { await db.update('Delegation_Tasks', tid, { last_reminder_date: todayStr }); } catch (e) { /* skip */ }
        }
        sent++;
      } catch (e) {
        console.error('  Reminder failed for', email, e.message);
        failed++;
      }
    }
    console.log(`  Reminder pass @ ${todayStr}: ${sent} email(s) sent, ${failed} failed`);
    return { sent, failed };
  } catch (err) {
    console.error('  runDelegationReminders error:', err.message);
    return { error: err.message };
  }
}

let _lastReminderRunDate = '';
function reminderScheduler() {
  if (!EMAIL_ENABLED) { console.log('  Email reminders disabled (EMAIL_ENABLED=false) — WhatsApp only'); return; }
  setInterval(async () => {
    try {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      if (now.getHours() >= 12 && _lastReminderRunDate !== todayStr) {
        _lastReminderRunDate = todayStr;
        await runDelegationReminders();
      }
    } catch (e) { console.error('  Scheduler tick error:', e.message); }
  }, 60 * 1000);
  console.log('  Delegation reminder scheduler started (fires daily at 12:00 PM)');
}

// ══════════════════════════════════════════════════════
// WHATSAPP  (Aumpfy custom trigger API)
// ══════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
// WHATSAPP — POORA SYSTEM EK JAGAH (rewrite: 20 Aug 2026)
// ════════════════════════════════════════════════════════════════════════
// Ye poora module ek hi kaam karta hai: WhatsApp message bhejna, bina kisi
// ko kabhi chhoote. Yahan se 3 tarah ke message jaate hain — task assign
// karte waqt ka alert, daily reminder (10:15 & 5PM), aur PMS/FMS sheet ke
// notification. Teeno isi ek raste se guzarte hain.
//
// KAAM KAISE HOTA HAI (upar se neeche padho, yahi poora flow hai):
//
//  1. CONFIG — whatsapp.config.js se DO API load hoti hain:
//       WA          → delegation, checklist, daily reminder
//       WA.pms      → PMS/FMS sheet ke notification
//     `kind` string (jaise 'fms-notify') decide karta hai kaunsi API use
//     hogi — waApiFor() dekho. (20 Aug: pehle ek hi API thi, phir Harsh ne
//     PMS ko wapas apni alag API par bhej diya — dono chalu hain.)
//
//  2. QUEUE (queueWhatsApp) — koi bhi message bhejne se PEHLE DB (WA_Outbox)
//     me likha jaata hai. App restart ho jaye, Aumpfy fail kare, kuch bhi ho
//     — message DB me surakshit padha rehta hai. Isके baad turant bhejne ki
//     koshish hoti hai (assign-time alert ke liye) — kataar me nahi lagta.
//
//  3. SEND (sendWhatsApp) — asli HTTP POST Aumpfy ko. Kabhi throw nahi karta,
//     hamesha { ok, error/status } jaisa object deta hai.
//
//  4. BREAKER — agar Aumpfy khud hi jawab na de (timeout/502/503), to us
//     galti ko "upstream ki kharabi" maana jaata hai — message ki koshish
//     ginti nahi katti (isUpstreamDown). Lagatar 3 aisi galti par us API ka
//     breaker 10 min ke liye "band" ho jaata hai — tab tak uske message POST
//     hi nahi hote, taaki na Aumpfy par bojh pade na message bar-bar POST ho
//     kar kisi ko duplicate mile.
//
//  5. DRAIN (drainWhatsAppOutbox) — har 60s tick par chalta hai. Jo message
//     pending pade hain (aur jinki API band nahi hai) unhe 3-3 ke batch me
//     bhejta hai. Har message zyada se zyada 3 baar koshish (asli galti par)
//     aur zyada se zyada 2 baar POST (jawab chahe kuch bhi aaye — warna
//     Aumpfy jawab na de kar bhi message pahuncha de to duplicate ho jaate).
//
//  6. REVIVE — 'failed' ho chuke message (24 ghante ke andar wale) ko har
//     20 min me phir mauka milta hai, max 3 baar.
//
// HAMESHA YAAD RAKHNA (Harsh ke pakke niyam):
//   - Message KABHI seedha sendWhatsApp() se mat bhejo. Hamesha
//     queueWhatsApp() se — warna fail hone par gum ho jaata hai.
//   - Ek API doosri ke liye kabhi fallback nahi karti (WA.allowApiFallback
//     hamesha false rakhna) — delegation/checklist/reminder hamesha default
//     API se hi, PMS/FMS hamesha pms API se hi.
//   - Diagnose: GET /api/cron/wa-reminders ke JSON me `outbox` field —
//     sent/pending/failed/sending/unknown ki ginti, aakhri galti, aur
//     kaunsi API band hai (agar koi ho).
// ════════════════════════════════════════════════════════════════════════

// ── 1) CONFIG ──────────────────────────────────────────────────────────
// whatsapp.config.js gitignored... nahi, ye file git-tracked hai (repo
// public hai) — API settings badalne ke liye seedha wahi file edit karo,
// phir app restart karo.
let WA;
try {
  WA = require('./whatsapp.config');
} catch (e) {
  WA = require('./whatsapp.config.example');
  console.log('  whatsapp.config.js not found — using whatsapp.config.example.js (env-based). Copy it to whatsapp.config.js to set your API.');
}

// Koi bhi stored phone value -> WhatsApp ka digit format (country code +
// number, koi +/space nahi).
function normalizePhone(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  d = d.replace(/^0+/, '');
  if (d.length <= 10) d = WA.countryCode + d;
  return d;
}

// ── 2) KIS MESSAGE KE LIYE KAUNSI API ─────────────────────────────────
// EK HI PHONE, SAARE MESSAGE (Harsh, 20 Aug 2026): delegation, checklist,
// daily reminder, PMS/FMS sheet — sab isi ek whatsapp.config.js wali
// url/apiKey se jaate hain. Alag-alag API/session ka jhanjhat khatam.
// PMS/FMS sheet ke notification alag session (pms) se jaate hain. Baaki
// SAB (delegation, checklist, daily reminder) default se. Harsh, 20 Aug
// shaam: "PMS ke number pr message pms-08a73f custom API se jayenge" —
// dobara do API me split kiya.
function waApiFor(kind) {
  if (String(kind || '') === 'fms-notify' && WA.pms && WA.pms.url && WA.pms.apiKey) {
    return { url: WA.pms.url, apiKey: WA.pms.apiKey, name: 'pms' };
  }
  return { url: WA.url, apiKey: WA.apiKey, name: 'default' };
}

// Doosri API se bhejna — SIRF tab jab whatsapp.config.js me
// allowApiFallback:true ho. Default false: delegation/checklist/reminder
// hamesha default se, PMS/FMS hamesha pms se — ek doosre ko cross nahi karte.
function waOtherApi(name, kind) {
  if (!WA.allowApiFallback) return null;
  if (name === 'pms') return { url: WA.url, apiKey: WA.apiKey, name: 'default' };
  if (name === 'default' && WA.pms && WA.pms.url && WA.pms.apiKey) {
    return { url: WA.pms.url, apiKey: WA.pms.apiKey, name: 'pms' };
  }
  return null;
}

// ── 3) CIRCUIT BREAKER (har API ka alag) ──────────────────────────────
// Timeout/502/503/504/network jaisi galti "upstream ki kharabi" hai —
// message ki apni galti nahi. Aisi galti par koshish ki ginti nahi katti,
// aur lagatar 3 aisi galti par us API ke liye kataar 10 min ruk jaati hai.
function isUpstreamDown(err) {
  const e = String(err == null ? '' : err).toLowerCase();
  return e.includes('timeout') || e.includes('aborted') || e.includes('abort')
    || e.includes('econn') || e.includes('enotfound') || e.includes('socket')
    || e.includes('network') || e.includes('fetch failed')
    || e === '502' || e === '503' || e === '504' || e === '500';
}

// Galti ki teen kism — inka farak SABSE zaroori hai (20 Aug ko Nishant ko ek
// reminder 6 baar gaya, isi farak ko na samajhne ki wajah se):
//
//  a) CONNECT hi nahi hua (ECONNREFUSED/ENOTFOUND/fetch failed) — request
//     Aumpfy tak pahunchi hi nahi => message PAKKA nahi gaya => dobara
//     bhejna 100% safe.
//  b) AMBIGUOUS (timeout / 502-504) — request nikal gayi, jawab nahi aaya.
//     Aumpfy AKSAR aise me message pahuncha chuka hota hai (logs me dikha).
//     => dobara bhejna = bande ko wahi message phir se. KABHI auto-resend
//     nahi — row 'unknown' hokar wahin rukti hai.
//  c) CONFIG/MESSAGE kharab (400/401/404) — bheja, Aumpfy ne mana kar diya
//     => message nahi gaya, par dobara bhejne se bhi wahi hoga. Ginti ke
//     saath 2-3 koshish, phir 'failed'.
function isConnectError(err) {
  const e = String(err == null ? '' : err).toLowerCase();
  return e.includes('econnrefused') || e.includes('enotfound')
    || e.includes('eai_again') || e.includes('fetch failed');
}
const WA_BREAKER_TRIP_AFTER = 3;
const WA_BREAKER_COOLDOWN_MS = 10 * 60 * 1000;
const _waBreaker = {};   // { apiName: { streak, until } }
function _brk(name) { return (_waBreaker[name] = _waBreaker[name] || { streak: 0, until: 0 }); }
function waBreakerOpen(name) { return Date.now() < _brk(name || 'default').until; }
function waNoteSendResult(ok, err, name) {
  const b = _brk(name || 'default');
  if (ok) { b.streak = 0; b.until = 0; return; }
  if (!isUpstreamDown(err)) return;
  b.streak++;
  if (b.streak >= WA_BREAKER_TRIP_AFTER && Date.now() >= b.until) {
    b.until = Date.now() + WA_BREAKER_COOLDOWN_MS;
    console.error(`  WA breaker [${name}]: jawab nahi de raha — ${WA_BREAKER_COOLDOWN_MS / 60000} min ruk rahe hain, message surakshit hain`);
  }
}

// ── 4) ASLI SEND — ek HTTP POST, kabhi throw nahi karta ───────────────
async function sendWhatsApp(rawPhone, message, timeoutMs, kind, apiOverride) {
  if (!WA.enabled) return { skipped: 'disabled' };
  const phone = normalizePhone(rawPhone);
  if (!phone) return { skipped: 'no-phone' };
  const api = apiOverride || waApiFor(kind);
  if (!api.url || !api.apiKey) return { skipped: 'not-configured' };
  try {
    const resp = await fetch(api.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [WA.authHeader || 'x-api-key']: api.apiKey },
      body: JSON.stringify({ [WA.phoneField || 'to']: phone, [WA.messageField || 'text']: message }),
      signal: AbortSignal.timeout(timeoutMs || WA.timeoutMs || 20000)
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.error(`  WhatsApp failed (${phone}) [${api.name} ${resp.status}]: ${body.slice(0, 200)}`);
      return { ok: false, status: resp.status, body };
    }
    console.log(`  WhatsApp sent to ${phone} (${api.name})`);
    return { ok: true, status: resp.status, body };
  } catch (err) {
    console.error(`  WhatsApp error (${phone}): ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// Apni API + (agar allowed ho) fallback API try karta hai. Fallback SIRF
// upstream-down par — galat number/key par dono API wahi galti dengi,
// isliye bekaar do baar nahi bhejta.
async function sendWhatsAppSure(rawPhone, message, timeoutMs, kind) {
  const primary = waApiFor(kind);
  const backup = waOtherApi(primary.name, kind);
  const order = (backup && waBreakerOpen(primary.name)) ? [backup, primary] : [primary, backup];

  let last = null;
  for (const api of order) {
    if (!api) continue;
    const r = await sendWhatsApp(rawPhone, message, timeoutMs, kind, api)
      .catch(e => ({ ok: false, error: e.message }));
    waNoteSendResult(!!(r && r.ok), (r && (r.error || r.status)) || '', api.name);
    if (r && r.ok) {
      if (api.name !== primary.name) {
        console.log(`  WA: ${primary.name} band tha, message ${api.name} se bhej diya`);
      }
      return r;
    }
    last = r;
    if (!isUpstreamDown((r && (r.error || r.status)) || '')) return r;
  }
  return last || { ok: false, error: 'no-api' };
}

// ── 5) OUTBOX — DB me pehle likho, phir bhejo ─────────────────────────
const WA_OUTBOX_MAX_ATTEMPTS = 3;    // asli galti (401/400) par itni baar koshish
// 21 Aug: Aumpfy ka SAFAL jawab bhi 88.9s me aaya (live test) — 90s timeout
// bilkul kinare par tha, safal message bhi 'unknown' ban rahe the. 150s par
// aisa nahi hoga; asli delivery to POST ke turant baad ho jaati hai, ye sirf
// confirmation ka intezaar hai.
const WA_OUTBOX_SEND_TIMEOUT = 150000;
const WA_OUTBOX_PER_RUN = 30;         // ek tick me itne message uthao
// Ab EK hi session poora traffic (delegation+checklist+reminder+FMS) sambhalta
// hai — 3 saath-saath bhejne par response time 5s se badhkar 57s tak chala
// gaya (20 Aug, live dekha). Isliye 2 par le aaye — kam bojh, kam timeout.
const WA_OUTBOX_CONCURRENCY = 2;
const WA_OUTBOX_MAX_POSTS = 2;        // jawab chahe kuch bhi aaye, itni baar POST karke ruk jao
const WA_OUTBOX_MAX_REVIVALS = 3;     // 'failed' ho chuke ko itni baar phir mauka

async function queueWhatsApp(phone, message, kind, ref, person, opts) {
  const to = normalizePhone(phone);
  if (!to || !message) return null;
  try {
    const d = await getDB();
    const row = await d.insert('WA_Outbox', {
      phone: to, message: String(message), kind: kind || '', ref: String(ref || ''),
      person: String(person || ''), status: 'pending', attempts: '0', last_error: '',
      created_at: new Date().toISOString().replace('T', ' ').split('.')[0], sent_at: ''
    });
    // Naya message LINE ME NAHI lagta — turant bhejte hain (assign-time alert
    // ke liye). Bade batch (daily reminder) me opts.immediate:false aata hai —
    // wahan sirf kataar me lagta hai, drain use ek-ek karke bhejta hai.
    if (!opts || opts.immediate !== false) sendNowThenSettle(d, row).catch(() => {});
    return row;
  } catch (e) {
    console.error('  queueWhatsApp failed, seedha bhej rahe hain:', e.message);
    return sendWhatsApp(to, message);   // DB na chale to purana tareeka
  }
}

// Ek message ABHI bhejo, drain ke lock ka intezaar kiye bina. Row pehle
// 'sending' hoti hai taaki drain isi ko saath me dobara na bhej de.
async function sendNowThenSettle(d, row) {
  if (!row || !row.id) return;
  try {
    await d.update('WA_Outbox', row.id, { status: 'sending', attempts: '1', posts: '1' });
  } catch (e) {
    console.error('  WA outbox — sending likhna fail:', e.message);
    return;   // drain baad me uthayega
  }
  const r = await sendWhatsAppSure(row.phone, row.message, WA_OUTBOX_SEND_TIMEOUT, row.kind)
    .catch(e => ({ ok: false, error: e.message }));
  const ok = !!(r && r.ok);
  const err = String((r && (r.error || r.status)) || 'unknown');
  let patch;
  if (ok) {
    patch = { status: 'sent', sent_at: new Date().toISOString().replace('T', ' ').split('.')[0] };
  } else if (isConnectError(err)) {
    // Request nikli hi nahi — retry 100% safe
    patch = { status: 'pending', attempts: '0', posts: '0', last_error: err };
  } else if (isUpstreamDown(err)) {
    // Jawab nahi mila — message pahuncha ho sakta hai. Duplicate se bachne ke
    // liye FINAL 'unknown', koi auto-resend nahi.
    patch = { status: 'unknown', last_error: `jawab nahi mila (${err}) — pahuncha ho sakta hai, dobara NAHI bhejenge` };
  } else {
    patch = { status: 'pending', attempts: '1', last_error: err };
  }
  if (!ok) _outboxLastError = err;
  await d.update('WA_Outbox', row.id, patch).catch(() => {});
}

// Harsh, 20 Aug shaam: "pending messages stop kardo clear kardo... abse new
// hi jayege purana kuch nhi bejna." Session outage ke dauraan jamaa hua saara
// PURANA backlog (pending/sending/failed/unknown) mita do — jo pehle se
// 'sent' ho chuke unhe haath mat lagao (wo history hai). Ek hi baar chalta
// hai; is marker ke baad bana koi bhi NAYA message normal tarike se jayega.
async function clearOldOutboxBacklog() {
  const MARKER = 'wa_backlog_cleared_20aug_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const rows = await d.findAll('WA_Outbox');
    const stale = rows.filter(r => r.status !== 'sent');
    if (stale.length) {
      if (typeof d.batchDeleteByIds === 'function') {
        await d.batchDeleteByIds('WA_Outbox', stale.map(r => r.id));
      } else {
        for (const r of stale) await d.delete('WA_Outbox', r.id).catch(() => {});
      }
    }
    await d.insert('App_State', {
      key_name: MARKER, value: `cleared ${stale.length}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ Outbox backlog saaf: ${stale.length} purane message hata diye — ab sirf naye jayenge`);
  } catch (e) {
    console.error('  clearOldOutboxBacklog error:', e.message);
  }
}

// 19-20 Aug ko purana session baitha tha, isliye kai message 'failed' ho
// gaye the. Ek baar ke liye sabko saaf naya mauka.
async function resetFailedAfterApiSwitch() {
  const MARKER = 'wa_reset_after_pms_api_v1';
  try {
    if (!waAutoAllowed()) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const rows = await d.findAll('WA_Outbox');
    const stuck = rows.filter(r => r.status !== 'sent');
    for (const r of stuck) {
      await d.update('WA_Outbox', r.id, {
        status: 'pending', attempts: '0', revivals: '0', last_error: ''
      }).catch(() => {});
    }
    await d.insert('App_State', {
      key_name: MARKER, value: `reset ${stuck.length}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    if (stuck.length) console.log(`  ✅ ${stuck.length} atke message ko naya mauka (naya PMS API ke baad)`);
    drainWhatsAppOutbox().catch(() => {});
  } catch (e) {
    console.error('  resetFailedAfterApiSwitch error:', e.message);
  }
}

// 'failed' ho chuke (24 ghante ke andar wale) ko har 20 min me phir mauka —
// max 3 baar. Har mauke me theek EK koshish.
async function reviveFailedOutbox() {
  try {
    if (!WA.enabled || !WA.url || !WA.apiKey) return { skipped: 'wa-not-configured' };
    const d = await getDB();
    const rows = await d.findAll('WA_Outbox');
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace('T', ' ').split('.')[0];
    let revived = 0;
    for (const r of rows) {
      // SIRF 'failed' (config/message kharabi wale). 'unknown' ko KABHI nahi —
      // unknown ka matlab hai "pahuncha ho sakta hai": revive karne se Nishant
      // ko 20 Aug ko ek reminder 6 baar gaya tha (har 20-min tick unhe naya
      // mauka de raha tha aur Aumpfy har baar pahuncha bhi raha tha). Unknown
      // manually hi bheje ja sakte hain: /api/admin/wa-outbox?retry=1
      if (r.status !== 'failed') continue;
      if (String(r.created_at || '') < dayAgo) continue;
      const n = parseInt(r.revivals) || 0;
      if (n >= WA_OUTBOX_MAX_REVIVALS) continue;
      // posts RESET NAHI hota — POST ki kul ginti hamesha aage badhti hai
      await d.update('WA_Outbox', r.id, {
        status: 'pending', attempts: String(WA_OUTBOX_MAX_ATTEMPTS - 1), revivals: String(n + 1)
      }).catch(() => {});
      revived++;
    }
    if (revived) {
      console.log(`  WA outbox: ${revived} fail hue message ko phir mauka`);
      drainWhatsAppOutbox().catch(() => {});
    }
    return { revived };
  } catch (e) {
    console.error('  reviveFailedOutbox error:', e.message);
    return { error: e.message };
  }
}

// ── 6) DRAIN — har 60s tick, poori kataar ka ek pass ──────────────────
let _outboxRunning = false;
let _outboxLastError = '';   // aakhri wajah — bina login diagnose ke liye

async function drainWhatsAppOutbox() {
  if (_outboxRunning) return { skipped: 'already-running' };
  if (!WA.enabled || !WA.url || !WA.apiKey) return { skipped: 'wa-not-configured' };
  _outboxRunning = true;
  try {
    const d = await getDB();
    const all = await d.findAll('WA_Outbox');

    // App beech me band ho gayi to koi row 'sending' me atak sakti hai —
    // 10 min purani ho to wapas kataar me
    const staleBefore = new Date(Date.now() - 10 * 60000).toISOString().replace('T', ' ').split('.')[0];
    for (const r of all) {
      if (r.status === 'sending' && String(r.created_at || '') < staleBefore) {
        await d.update('WA_Outbox', r.id, { status: 'pending' }).catch(() => {});
        r.status = 'pending';
      }
    }
    // Koshish poori kar chuke pending -> failed (revive inhe wapas layegi)
    for (const r of all) {
      if (r.status === 'pending' && (parseInt(r.attempts) || 0) >= WA_OUTBOX_MAX_ATTEMPTS) {
        await d.update('WA_Outbox', r.id, { status: 'failed' }).catch(() => {});
        r.status = 'failed';
      }
    }

    const pending = all
      .filter(r => r.status === 'pending' && (parseInt(r.attempts) || 0) < WA_OUTBOX_MAX_ATTEMPTS)
      .slice(0, WA_OUTBOX_PER_RUN);
    if (!pending.length) return { pending: 0 };

    // Jis API baithi hai, uske message ABHI mat bhejo — har message apni API
    // ka breaker dekhta hai (ek API baithi ho to doosri par asar nahi).
    const ready = pending.filter(r => !waBreakerOpen(waApiFor(r.kind).name));
    const held = pending.length - ready.length;
    if (!ready.length) return { skipped: 'aumpfy-down', waiting: held };
    if (held) console.log(`  WA outbox: ${held} message ruke hain (unki API band hai)`);

    let sent = 0, failed = 0;
    const processRow = (async row => {
        // ── DAILY REMINDER SIRF APNE DIN + APNE WAQT PAR ──
        // 21 Aug subah 9:47 par logon ko reminder mila — wo KAL shaam 5 baje
        // ke baasi reminder the jo band system me raat bhar pade rahe aur
        // resume hote hi nikal gaye. Harsh ka niyam: reminder SIRF 10:15/5:00
        // par, aur 7 PM ke baad kabhi nahi. Isliye: reminder apne din ke
        // alawa, ya 7 PM ke baad, KABHI nahi bheja jaata — baasi ho to
        // 'expired' likh kar chhod dete hain. (Assign-time alert par koi
        // rok nahi — wo kabhi bhi ja sakta hai, Harsh ne wahi kaha hai.)
        // Greeting par bhi wahi rok: apne din ke baad, ya 7 PM ke baad, kabhi
        // nahi. Raat ko "Happy Navratri" pahunchna greeting nahi, pareshani hai.
        if (row.kind === 'daily-reminder' || row.kind === 'festival-wish') {
          const istNow = new Date(Date.now() + 330 * 60000);
          const todayIst = istNow.toISOString().split('T')[0];
          const m = String(row.ref || '').match(/\d{4}-\d{2}-\d{2}/);
          const refDate = m ? m[0] : '';
          const nowMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
          if (refDate !== todayIst || nowMin >= 19 * 60) {
            await d.update('WA_Outbox', row.id, {
              status: 'expired',
              last_error: `baasi reminder (${refDate || 'bina-date'}) — slot nikal chuka, bheja NAHI`
            }).catch(() => {});
            return;
          }
        }
        const attempts = (parseInt(row.attempts) || 0) + 1;
        const posts = (parseInt(row.posts) || 0) + 1;
        if (posts > WA_OUTBOX_MAX_POSTS) {
          // Itni baar POST kar chuke, Aumpfy ne kabhi jawab nahi diya. Aur
          // bhejna = banda ko duplicate. Sach likh do — 'sent' nahi bolenge.
          await d.update('WA_Outbox', row.id, {
            status: 'unknown', last_error: `${WA_OUTBOX_MAX_POSTS} baar bheja, Aumpfy ne jawab nahi diya`
          }).catch(() => {});
          return;
        }
        // Attempts PEHLE likho, phir bhejo — likhai fail ho to bhejo hi mat,
        // warna row hamesha 'pending' reh kar duplicate bhej sakti hai.
        try {
          await d.update('WA_Outbox', row.id, { attempts: String(attempts), posts: String(posts) });
        } catch (e) {
          _outboxLastError = `attempts likhna fail (id=${row.id}): ${e.message}`;
          console.error('  WA outbox — ' + _outboxLastError);
          return;
        }
        const r = await sendWhatsAppSure(row.phone, row.message, WA_OUTBOX_SEND_TIMEOUT, row.kind)
          .catch(e => ({ ok: false, error: e.message }));
        if (r && r.ok) {
          sent++;
          try {
            await d.update('WA_Outbox', row.id, {
              status: 'sent', sent_at: new Date().toISOString().replace('T', ' ').split('.')[0]
            });
          } catch (e) {
            _outboxLastError = `sent likhna fail (id=${row.id}): ${e.message}`;
            console.error('  WA outbox — ' + _outboxLastError);
          }
        } else {
          failed++;
          const err = (r && (r.error || r.skipped || r.status)) || 'unknown';
          _outboxLastError = String(err);
          let patch, label;
          if (isConnectError(err)) {
            // Request nikli hi nahi — message pakka nahi gaya, refund + retry safe
            patch = { status: 'pending', attempts: String(attempts - 1), posts: String(posts - 1), last_error: String(err) };
            label = 'connect-fail, dobara jayega';
          } else if (isUpstreamDown(err)) {
            // AMBIGUOUS: Aumpfy ne jawab nahi diya par message pahuncha chuka ho
            // sakta hai. Dobara bhejna = duplicate (Nishant ko 6x isi se gaya).
            // FINAL 'unknown' — koi auto-resend nahi. Manually:
            // /api/admin/wa-outbox?retry=1
            patch = { status: 'unknown', last_error: `jawab nahi mila (${err}) — pahuncha ho sakta hai, isliye dobara NAHI bhejenge` };
            label = 'jawab nahi mila — duplicate se bachne ke liye yahin ruke';
          } else {
            // Config/message kharab (401/400/404) — ginti ke saath retry, phir failed
            const giveUp = attempts >= WA_OUTBOX_MAX_ATTEMPTS;
            patch = { status: giveUp ? 'failed' : 'pending', attempts: String(attempts), last_error: String(err) };
            label = giveUp ? 'GAVE UP' : 'retry';
          }
          try {
            await d.update('WA_Outbox', row.id, patch);
          } catch (e) {
            console.error('  WA outbox — status likhna fail:', e.message);
          }
          console.error(`  WA outbox ${label} (${attempts}/${WA_OUTBOX_MAX_ATTEMPTS}) — ${row.person || row.phone}: ${err}`);
        }
      });

    // Assign-alert wagera pehle jaise (2-2 saath, turant). DAILY REMINDER
    // EK-EK karke, beech me reminderGapMs (80s) ka gap — Harsh, 25 Aug:
    // "80 second kar do, message queue me fas rahe hain." Isse Waumfy ki
    // apni queue kabhi nahi bharti aur warm-up/rate-limit bhi nahi chhidta.
    const fastRows = ready.filter(r => r.kind !== 'daily-reminder');
    const slowRows = ready.filter(r => r.kind === 'daily-reminder');
    for (let i = 0; i < fastRows.length; i += WA_OUTBOX_CONCURRENCY) {
      await Promise.all(fastRows.slice(i, i + WA_OUTBOX_CONCURRENCY).map(processRow));
    }
    const GAP = Math.max(0, parseInt(WA.reminderGapMs, 10) || 0);
    for (let i = 0; i < slowRows.length; i++) {
      await processRow(slowRows[i]);
      if (GAP && i < slowRows.length - 1) await new Promise(r => setTimeout(r, GAP));
    }
    if (sent || failed) console.log(`  WA outbox: ${sent} sent, ${failed} retry/failed`);
    return { sent, failed };
  } catch (err) {
    console.error('  drainWhatsAppOutbox error:', err.message);
    return { error: err.message };
  } finally {
    _outboxRunning = false;
  }
}


// Checklist row me rakhne ke liye doer ka naam. Sirf DB me padhne ki aasani
// ke liye — kabhi fail ho to khali chhod dete hain, task banna nahi rukta.
async function doerNameFor(userId) {
  try {
    const u = await db.findOne('Users', { id: String(userId) });
    return (u && u.name) ? String(u.name) : '';
  } catch { return ''; }
}

// Resolve a user's WhatsApp target ({ name, phone }) or null if no usable phone.
async function getWhatsAppTarget(userId) {
  try {
    const user = await db.findOne('Users', { id: String(userId) });
    if (!user || !user.phone) return null;
    const phone = normalizePhone(user.phone);
    if (!phone) return null;
    return { name: user.name, phone };
  } catch { return null; }
}

// ── Message templates (English) ──
function waDelegationMsg({ assigneeName, assignerName, desc, dueDate, priority, approval, remarks }) {
  const url = process.env.APP_URL || '';
  const lines = [
    '*Raabta Task Manager*',
    '',
    `Hello ${assigneeName || 'there'},`,
    `A new *delegation task* has been assigned to you by ${assignerName || 'Admin'}.`,
    '',
    `*Task:* ${desc}`,
    `*Due Date:* ${dueDate}`,
    `*Priority:* ${priority || 'low'}`,
    `*Approval Required:* ${approval || 'no'}`
  ];
  if (remarks) lines.push(`*Remarks:* ${remarks}`);
  lines.push('', 'Please complete it and mark it as Done in the app.');
  if (url) lines.push(`Open: ${url}`);
  return lines.join('\n');
}

// Approver ko — jab task delegate hote waqt "Approval Required: Yes" chuna
// jaye aur koi approver select ho. Harsh, 11 Sep 2026: "ush ke paas bhi
// message jana chahiye ki aap ko ye task approve karna hai, ye doer hai."
function waApproverMsg({ approverName, doerName, assignerName, desc, dueDate, priority, remarks }) {
  const url = process.env.APP_URL || '';
  const lines = [
    '*Raabta Task Manager*',
    '',
    `Hello ${approverName || 'there'},`,
    'You have been set as the *approver* for a delegation task.',
    '',
    `*Task:* ${desc}`,
    `*Doer:* ${doerName || '-'}`,
    `*Assigned By:* ${assignerName || 'Admin'}`,
    `*Due Date:* ${dueDate}`,
    `*Priority:* ${priority || 'low'}`
  ];
  if (remarks) lines.push(`*Remarks:* ${remarks}`);
  lines.push('', 'When the doer marks it as Done, the approval request will come to you.');
  if (url) lines.push(`Open: ${url}`);
  return lines.join('\n');
}

function waChecklistMsg({ assigneeName, desc, dueText, count }) {
  const url = process.env.APP_URL || '';
  const lines = [
    '*Raabta Task Manager*',
    '',
    `Hello ${assigneeName || 'there'},`,
    count > 1
      ? `A new *checklist* with *${count}* tasks has been assigned to you.`
      : 'A new *checklist task* has been assigned to you.',
    '',
    `*Task:* ${desc}`,
    `*Due:* ${dueText}`,
    '',
    'Please complete it and mark it as Done in the app.'
  ];
  if (url) lines.push(`Open: ${url}`);
  return lines.join('\n');
}

function waReminderMsg(name, tasks, todayStr) {
  const url = process.env.APP_URL || '';
  const shown = tasks.slice(0, 10);
  const lines = [
    '*Raabta Task Manager — Daily Reminder*',
    '',
    `Hello ${name || 'there'}, you have *${tasks.length}* pending task${tasks.length > 1 ? 's' : ''} not yet marked Done:`,
    ''
  ];
  shown.forEach((t, i) => {
    const tag = t.due_date < todayStr ? ' (OVERDUE)' : (t.due_date === todayStr ? ' (Today)' : '');
    lines.push(`${i + 1}. [${t.kind}] ${t.description || '—'} — Due: ${t.due_date || '—'}${tag}`);
  });
  if (tasks.length > shown.length) lines.push(`…and ${tasks.length - shown.length} more.`);
  lines.push('', 'Please complete them and mark each as Done.');
  if (url) lines.push(`Open: ${url}`);
  return lines.join('\n');
}

// ── Daily WhatsApp reminder pass (delegation + checklist, one message per user) ──
// ── Reminder pass ke do safety guards ──
// 1) In-flight lock: ek pass chal raha ho to doosra shuru nahi hota (varna app
//    par double load padta tha aur 504 aata tha).
// 2) DB marker: "aaj is slot ka pass ho chuka" DB me likha jaata hai, isliye
//    app restart hone par bhi logon ko duplicate reminder nahi jaate.
let _waPassInFlight = false;

async function _waSlotDone(marker) {
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const rows = await d.findWhere('App_State', { key_name: marker });
    return !!(rows && rows.length);
  } catch (e) { return false; }   // table na ho to purana behaviour
}
async function _waMarkSlotDone(marker) {
  try {
    const d = await getDB();
    await d.insert('App_State', {
      key_name: marker, value: 'sent',
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
  } catch (e) { /* marker na likh paye to bhi pass chalta rahe */ }
}

// DIN-BHAR KA HARD CAP: reminder ek din me zyada se zyada itni baar hi
// jaayega jitne slot configured hain (aam taur par 2 — subah + shaam). Agar
// reminderTimes din ke beech me badal di jaaye (10:15 -> 10:00 jaisa), to har
// naya h:m apna NAYA marker banata hai — aur bina is cap ke system use "aaj
// abhi tak nahi gaya" samajh kar dobara bhej deta. 20 Aug ko yahi hua tha:
// 4 alag time try kiye gaye = 4 alag marker = ek bande ko 4 reminder. Ab
// chahe time kitni baar badlo, EK DIN me kul passes kabhi is se zyada nahi
// honge.
async function _waPassesToday(dateStr) {
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const rows = await d.findAll('App_State');
    const prefix = `wa_pass_${dateStr}_`;
    return rows.filter(r => String(r.key_name || '').startsWith(prefix)).length;
  } catch (e) { return 0; }
}

async function runWhatsAppReminders(slotKey, force) {
  if (!WA.enabled) return { skipped: 'disabled' };
  // OFFICE HOURS GUARD (hard rule): reminders subah ke pehle slot se pehle
  // aur 7 PM ke baad kabhi nahi jaate — scheduler, cron ya manual button,
  // kahin se bhi trigger ho. Sabse pehla slot whatsapp.config.js ke
  // reminderTimes se KHUD uthaya jaata hai — waha slot badlo, ye guard apne
  // aap saath badal jaata hai (pehle 10:15 hardcode tha, isliye jab time
  // 10:00 kiya to guard purana reh gaya aur naya slot khud hi block ho jaata
  // — ab aisa nahi hoga).
  const ist = new Date(Date.now() + 330 * 60000);
  const istHour = ist.getUTCHours();
  const istMin = istHour * 60 + ist.getUTCMinutes();
  const earliestSlot = [...waSlots()].sort((a, b) => (a.h * 60 + (a.m || 0)) - (b.h * 60 + (b.m || 0)))[0] || { h: 10, m: 0 };
  const OFFICE_START = earliestSlot.h * 60 + (earliestSlot.m || 0);
  const OFFICE_END   = 19 * 60;        // 7:00 PM
  if (istMin < OFFICE_START || istMin >= OFFICE_END) {
    const startLabel = `${earliestSlot.h}:${String(earliestSlot.m || 0).padStart(2, '0')}`;
    console.log(`  WhatsApp reminders skipped — outside office hours (${startLabel}-19:00 IST)`);
    return { skipped: 'outside-office-hours' };
  }
  if (_waPassInFlight) {
    console.log('  WhatsApp reminder pass already running — skipped');
    return { skipped: 'already-running' };
  }
  // Lock ko kisi bhi await se PEHLE set karo — warna do concurrent calls dono
  // check paas kar jaate hain aur sabko double message chala jaata hai.
  _waPassInFlight = true;
  try {
    // Slot marker: din + ghanta (11 baje ka pass aur 17 baje ka pass alag)
    // Marker SLOT ke naam se banta hai (current hour se nahi) — warna 17:00 ka
    // pass agar catch-up me 18:10 pe chale to alag marker banta aur duplicate
    // messages ja sakte the.
    const dateStr = ist.toISOString().split('T')[0];
    // Manual button (force) ka marker ALAG prefix se — daily cap sirf
    // 'wa_pass_'ginta hai, isliye admin kabhi bhi button dabaye, subah-shaam
    // ke automatic slot par koi asar nahi padta. (22 Aug: Harsh ne button
    // dabaya to cap bhar gaya tha aur 5 baje wala rukne wala tha — ab nahi.)
    const marker = force
      ? `wa_manual_${dateStr}_${istHour}${String(ist.getUTCMinutes()).padStart(2, '0')}`
      : `wa_pass_${dateStr}_${slotKey || istHour}`;
    if (!force && await _waSlotDone(marker)) {
      console.log(`  WhatsApp reminders already sent for ${marker} — skipped`);
      return { skipped: 'already-sent-today' };
    }
    // Din-bhar ka hard cap — configured slots se zyada passes kabhi nahi,
    // chahe beech me time kitni baar badal jaaye (dekho upar ka comment)
    if (!force) {
      const maxPerDay = Math.max(1, waSlots().length);
      const already = await _waPassesToday(dateStr);
      if (already >= maxPerDay) {
        console.log(`  WhatsApp reminders — aaj ${already}/${maxPerDay} pass ho chuke, ${marker} ROKA (din ka cap)`);
        return { skipped: 'daily-cap-reached', already, maxPerDay };
      }
    }
    await _waMarkSlotDone(marker);
    const todayStr = new Date().toISOString().split('T')[0];
    const cutoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [delegation, checklist, users] = await Promise.all([
      db.findAll('Delegation_Tasks'),
      db.findAll('Checklist_Tasks'),
      db.findAll('Users')
    ]);
    const userMap = {};
    for (const u of users) userMap[String(u.id)] = u;

    const isPending = t => t.status === 'pending' && t.due_date && dueIso(t.due_date) <= cutoff;
    const byUser = {};
    const push = (t, kind) => {
      const uid = String(t.assigned_to);
      (byUser[uid] = byUser[uid] || []).push({ ...t, kind });
    };
    for (const t of delegation) if (isPending(t)) push(t, 'Delegation');
    for (const t of checklist) if (isPending(t)) push(t, 'Checklist');

    // Messages PARALLEL batches me jaate hain, ek-ek karke nahi. Aumpfy har
    // message me ~50 sec leta hai — 40+ logon ko serially bhejne me 35+ minute
    // lagte the, aur Hostinger par app utni der me restart ho jaati thi, isliye
    // aadhe logon ko message milta hi nahi tha (marker "bhej diya" bol deta tha).
    // Batches me poora pass ab kuch minute me khatam ho jaata hai.
    const recipients = [];
    let noPhone = 0;
    // Harsh, 25 Aug: "ye number chhod kar" — 919999298678 khud bhejne wala
    // phone hai, khud ko hi reminder maar raha tha. Config ki list se skip.
    const excludedPhones = new Set((WA.reminderExcludePhones || []).map(normalizePhone).filter(Boolean));
    for (const uid of Object.keys(byUser)) {
      const user = userMap[uid];
      const phone = user && user.phone ? normalizePhone(user.phone) : '';
      if (!phone) { noPhone++; continue; }
      if (excludedPhones.has(phone)) { continue; }
      const tasks = byUser[uid].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
      recipients.push({ phone, name: user.name, tasks });
    }

    // Reminder ab OUTBOX se jaate hain — pehle DB me likhe jaate hain, phir
    // drain unhe EK-EK karke bhejta hai. Pehle 8 ek saath jaate the aur Aumpfy
    // un sabko timeout kar deta tha; marker "bhej diya" bol deta tha aur
    // message hamesha ke liye gum ho jaate the. Ab fail ho to retry hota hai.
    //
    // PER-BANDA DEDUP (20 Aug — Ashish 4x / Nishant 6x ke baad): ek bande ko
    // ek din me subah (AM) ka reminder EK hi baar ban sakta hai aur shaam
    // (PM) ka EK hi baar — chahe pass kitni bhi baar chale (time-change se
    // naya marker ban jaye, force ho, kuch bhi ho). Ref = rem_DATE_AM/PM,
    // outbox me wahi ref + wahi phone pehle se ho to us bande ko skip.
    const halfDay = (parseInt(String(slotKey || istHour).slice(0, 2), 10) < 13) ? 'AM' : 'PM';
    const remRef = `rem_${dateStr}_${halfDay}`;
    let alreadyQueued = new Set();
    try {
      const d = await getDB();
      const rows = await d.findAll('WA_Outbox');
      rows.forEach(r0 => {
        if (r0.kind === 'daily-reminder' && r0.ref === remRef) alreadyQueued.add(r0.phone);
      });
    } catch (e) { /* dedup na ho paye to bhi pass rukna nahi chahiye */ }

    let queued = 0, skippedDup = 0;
    for (const r of recipients) {
      if (alreadyQueued.has(r.phone)) { skippedDup++; continue; }
      const row = await queueWhatsApp(
        r.phone, waReminderMsg(r.name, r.tasks, todayStr),
        'daily-reminder', remRef, r.name, { immediate: false }
      );
      if (row) { queued++; alreadyQueued.add(r.phone); }
    }
    if (skippedDup) console.log(`  WA reminders: ${skippedDup} bande skip — aaj ${halfDay} ka reminder unke liye pehle hi ban chuka`);
    drainWhatsAppOutbox().catch(() => {});
    console.log(`  WhatsApp reminder pass @ ${todayStr}: ${recipients.length} recipients — ${queued} outbox me daale, ${noPhone} bina phone`);
    return { queued, noPhone, recipients: recipients.length };
  } catch (err) {
    console.error('  runWhatsAppReminders error:', err.message);
    return { error: err.message };
  } finally {
    _waPassInFlight = false;   // pass khatam/fail — lock hamesha chhoot jaaye
  }
}

let _waReminderDay = '';
const _waFiredSlots = new Set();
// Config se slots (IST). Default: 11:00 AM & 5:00 PM.
function waSlots() {
  return (Array.isArray(WA.reminderTimes) && WA.reminderTimes.length)
    ? WA.reminderTimes
    : (WA.reminderHour ? [{ h: WA.reminderHour, m: 0 }] : [{ h: 11, m: 0 }, { h: 17, m: 0 }]);
}

// Slot ke baad 2 ghante tak "catch-up" allowed hai. Shared hosting par app
// idle hone par so jaati hai — theek 11:00 baje koi tick miss ho jaye to bhi
// jagte hi (kisi bhi request par) reminder chala jaata hai. DB marker duplicate
// rokta hai, isliye late-but-sent safe hai.
const WA_CATCHUP_MIN = 120;   // (legacy) — ab catch-up slot-time se 7 PM tak hai

// Kya abhi koi slot due hai? Due ho to reminder pass chala do.
// Interval se bhi call hota hai aur har HTTP request par bhi (throttled).
// Automatic passes SIRF live server par. Local/dev par chalein to test karte
// waqt asli logon ko messages chale jaate. Admin ka manual button (force=true)
// har jagah kaam karta hai.
function waAutoAllowed() {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

async function checkAndFireDueSlots() {
  if (!waAutoAllowed()) return { skipped: 'not-production' };
  if (!WA.enabled || !WA.url || !WA.apiKey) return;
  const ist = new Date(Date.now() + 330 * 60000);
  // MONDAY SKIP — Harsh ne 23 Aug 2026 ko KHUD pakka kiya: "monday nhi
  // jayenga bhai." Daily reminder Monday ko nahi jaate. (Delegate-alert par
  // koi asar nahi — wo saaton din turant jaate hain.)
  if (ist.getUTCDay() === 1) return;                      // Monday skip
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const OFFICE_END = 19 * 60;   // 7:00 PM IST — catch-up isi tak
  // Slot due hai agar uska time nikal chuka hai aur abhi office hours ke andar
  // hain. Window slot-time se 7 PM tak — isliye app din me kabhi bhi khule (ya
  // koi request aaye) to us din ka missed reminder tab bhi chala jaata hai.
  // DB marker duplicate rokta hai (ek slot ek din me ek hi baar).
  const slots = [...waSlots()].sort((a, b) => (b.h * 60 + (b.m || 0)) - (a.h * 60 + (a.m || 0)));
  for (const s of slots) {   // baad wale slot ko pehle dekho (recent slot priority)
    const slotMin = s.h * 60 + (s.m || 0);
    if (nowMin >= slotMin && nowMin < OFFICE_END) {
      await getDB();
      // slotKey me ghanta+minute dono, taaki 10:40 jaise slots ka marker sahi bane
      return await runWhatsAppReminders(`${s.h}${String(s.m || 0).padStart(2, '0')}`);
    }
  }
  return { skipped: 'outside-slot-window' };
}

// ── Tyohaar ka greeting -- ek hi baar, sab ko ───────────────────────
// Harsh, 10 Oct: "kal se Navratri start hai, sab ko kal subah 6 baje message
// jana chahiye".
//
// Do baar kaise nahi jaata: har bande ka apna ref outbox me likha jaata hai
// (fest_navratri_<date>_<userId>). Dobara chalne par jiska ref pehle se hai
// use chhod dete hain. Isliye app chahe din me 50 baar jaage, message ek hi
// baar jaata hai. Aur ulta fayda bhi: pehli koshish me koi reh gaya to agli
// baar sirf wahi bacha hua judta hai -- kisi ka chhootta bhi nahi.
const FEST_WISH = {
  naam:    'Navratri',
  date:    '2026-10-11',        // IST ki date -- isi din jaata hai
  fromMin: 6 * 60,              // 6:00 AM IST se
  tillMin: 19 * 60,             // 7 PM ke baad bilkul nahi -- baasi greeting bekaar
  text:
    '\u{1F33A} *Happy Navratri* \u{1F33A}\n\n' +
    'Hello {name},\n\n' +
    'May Maa Durga bless you with strength, good health and happiness through these nine nights.\n\n' +
    'Wishing you and your family a very happy and prosperous Navratri.\n\n' +
    '\u2014 Team Raabta'
};

let _festWishRunning = false;
async function sendFestivalWish() {
  if (_festWishRunning) return { skipped: 'already-running' };
  if (!waAutoAllowed()) return { skipped: 'not-production' };
  if (!WA.enabled || !WA.url || !WA.apiKey) return { skipped: 'wa-not-configured' };
  const ist = new Date(Date.now() + 330 * 60000);
  if (ist.toISOString().split('T')[0] !== FEST_WISH.date) return { skipped: 'aaj ka din nahi' };
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (nowMin < FEST_WISH.fromMin) return { skipped: 'abhi 6 baje nahi' };
  if (nowMin >= FEST_WISH.tillMin) return { skipped: 'bahut der ho gayi' };

  _festWishRunning = true;
  try {
    const d = await getDB();
    const [users, outbox] = await Promise.all([
      d.findAll('Users'),
      d.findAll('WA_Outbox').catch(() => [])
    ]);
    const refFor = (u) => 'fest_navratri_' + FEST_WISH.date + '_' + u.id;
    // Jo pehle hi kataar me lag chuke -- unhe dobara mat lagao
    const pehleSe = new Set(
      outbox.filter(r => r.kind === 'festival-wish').map(r => String(r.ref || ''))
    );
    // Bhejne wala khud ka number chhodo (wahi list jo reminder me chhodi jaati hai)
    const chhodo = new Set((WA.reminderExcludePhones || []).map(normalizePhone).filter(Boolean));

    let queued = 0, pehleSeThe = 0, binaPhone = 0, chhode = 0;
    for (const u of users) {
      const ref = refFor(u);
      if (pehleSe.has(ref)) { pehleSeThe++; continue; }
      const phone = u.phone ? normalizePhone(u.phone) : '';
      if (!phone) { binaPhone++; continue; }
      if (chhodo.has(phone)) { chhode++; continue; }
      await queueWhatsApp(
        phone,
        FEST_WISH.text.replace('{name}', u.name || 'there'),
        'festival-wish', ref, u.name || '',
        { immediate: false }            // kataar me lagao -- drain ek-ek karke bhejega
      );
      queued++;
    }
    if (queued) {
      console.log('  \u{1F33A} ' + FEST_WISH.naam + ' greeting: ' + queued + ' kataar me (' +
                  pehleSeThe + ' pehle se, ' + binaPhone + ' bina phone, ' + chhode + ' chhode)');
      drainWhatsAppOutbox().catch(() => {});
    }
    return { queued, pehleSeThe, binaPhone, chhode };
  } catch (e) {
    console.error('  sendFestivalWish error:', e.message);
    return { error: e.message };
  } finally {
    _festWishRunning = false;
  }
}

// Har request par slot check — par minute me ek baar se zyada nahi.
let _waLastCheck = 0;
function waRequestHook(req, res, next) {
  const now = Date.now();
  if (now - _waLastCheck > 60000) {
    _waLastCheck = now;
    checkAndFireDueSlots().catch(e => console.error('  WA request-hook error:', e.message));
    sendFestivalWish().catch(e => console.error('  fest wish error:', e.message));
  }
  next();
}

// ── SELF KEEP-ALIVE ──
// Hostinger app ko tab sula deta hai jab koi HTTP request na aaye. Sote hue
// app ka setInterval tick nahi karta, isliye 10:15 ka slot miss ho jaata tha
// aur reminder tabhi jaata tha jab koi app khole. Isliye app KHUD ko har kuchh
// minute me ek request bhejti hai — traffic bana rehta hai, app jaagti rehti
// hai, aur slot apne aap chal jaata hai (kisi bahri cron ki zaroorat nahi).
let _keepAliveUrl = null;   // diagnostic endpoint ise dikhata hai
// Ye process kab shuru hua. Agar subah har baar naya process milta hai to
// matlab Hostinger ne raat me app ko sula/maar diya tha -- aur soyi hui app
// khud ko ping nahi kar sakti, isliye 10:15 ka tick nikal jaata hai.
// (8 Sep 2026 ko yahi shak hua, isliye ginti ke liye daala.)
const _bootAt = Date.now();
// Self-ping ka gap — ek hi jagah, taaki status me bhi wahi number dikhe
const KEEP_ALIVE_MIN = 2;
function selfKeepAlive() {
  // Sirf live server par — local machine par chala to test karte waqt asli
  // reminders chale jaate
  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    console.log('  Self keep-alive OFF (NODE_ENV production nahi hai)');
    return;
  }
  // Pehle .env, warna whatsapp.config.js ka appUrl — env par nirbhar nahi
  // rehna, warna set na hone par app so jaati hai aur slot nikal jaata hai
  const base = String(process.env.APP_URL || WA.appUrl || '').trim()
    .replace(/\/+$/, '').replace(/\/app$/, '');
  if (!base) {
    console.log('  Self keep-alive OFF — whatsapp.config.js me appUrl daalo (warna app so jayegi aur slot miss hoga)');
    return;
  }
  const url = `${base}/api/cron/wa-reminders`;
  _keepAliveUrl = url;
  // 8 Sep 2026: 4 min ka gap Hostinger ke idle-timeout ke bahut kareeb tha --
  // ek bhi ping late/fail hua to app so jaati thi aur subah ka slot nikal
  // jaata tha. 2 min par do ping fail hone par bhi guzaara ho jayega.
  const EVERY_MIN = KEEP_ALIVE_MIN;

  const ping = async () => {
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers: { 'X-Keep-Alive': '1' },
        signal: AbortSignal.timeout(20000)
      });
      // Sirf tab log karo jab kuch hua ho — warna logs bhar jaate hain
      const body = await r.json().catch(() => null);
      if (body && body.sentToday === false && body.slot) {
        console.log(`  keep-alive: slot ${body.slot} due tha — pass chalaya`);
      }
    } catch (e) {
      console.error('  keep-alive ping failed:', e.message);
    }
  };

  setInterval(ping, EVERY_MIN * 60 * 1000);
  setTimeout(ping, 30 * 1000);   // start hote hi ek baar (30 sec baad)
  console.log(`  Self keep-alive ON — har ${EVERY_MIN} min: ${url}`);
}

function whatsAppReminderScheduler() {
  if (!WA.enabled) { console.log('  WhatsApp reminders disabled (WHATSAPP_ENABLED=false)'); return; }
  if (!WA.url || !WA.apiKey) {
    console.log('  WhatsApp NOT configured — AUMPFY_API_URL / AUMPFY_API_KEY set karo, phir restart');
    return;
  }
  const label = waSlots().map(s => `${s.h}:${String(s.m || 0).padStart(2, '0')}`).join(' & ');
  setInterval(() => {
    checkAndFireDueSlots().catch(e => console.error('  WA scheduler tick error:', e.message));
    sendFestivalWish().catch(e => console.error('  fest wish tick error:', e.message));
    // Outbox: jo assign-time message pehli baar me nahi gaya, wo yahan retry
    // hota hai — isliye kisi ko message chhutta nahi
    drainWhatsAppOutbox().catch(e => console.error('  WA outbox tick error:', e.message));
  }, 60 * 1000);

  // Har 20 min: jo fail ho gaye the unhe phir mauka — tab tak Aumpfy aksar
  // theek ho chuka hota hai. Harsh ko koi button nahi dabana padta.
  setInterval(() => {
    reviveFailedOutbox().catch(e => console.error('  WA revive tick error:', e.message));
  }, 20 * 60 * 1000);
  setTimeout(() => reviveFailedOutbox().catch(() => {}), 90 * 1000);
  // FMS auto-notifications — pehle default rules seed karo, phir har 3 min
  // sheet check karke naye matches par bhejo
  setTimeout(() => {
    seedFMSNotifyRules()
      .then(() => runFMSNotifications())
      .catch(e => console.error('  FMS notify seed/first-run error:', e.message));
  }, 20 * 1000);
  setInterval(() => {
    runFMSNotifications().catch(e => console.error('  FMS notify tick error:', e.message));
  }, 3 * 60 * 1000);
  // Maintenance balance par nazar — kharch app se hota hai to wahin check ho
  // jaata hai, par sheet se bhi hisaab badalta hai, isliye har 30 min bhi.
  setInterval(() => {
    checkMaintLowBalance('har 30 min').catch(e => console.error('  maint low tick error:', e.message));
  }, 30 * 60 * 1000);
  setTimeout(() => checkMaintLowBalance('startup').catch(() => {}), 45 * 1000);

  selfKeepAlive();   // app khud ko jagati rahegi
  console.log(`  WhatsApp reminder scheduler started (daily ${label} IST, Monday skip, catch-up till 7PM)`);
}

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════
async function requireAuth(req, res, next) {
  try {
    await getDB();
  } catch (err) {
    return res.status(503).json({ error: 'Database connection failed — please retry: ' + err.message });
  }
  const token = req.cookies?.token || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.session = { userId: decoded.userId, role: decoded.role, name: decoded.name };
    next();
  } catch (e) { res.status(401).json({ error: 'Invalid token' }); }
}
function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Admin only' });
}
function requireAdminOrHod(req, res, next) {
  if (['admin', 'hod', 'pc'].includes(req.session.role)) return next();
  res.status(403).json({ error: 'Admin or HOD only' });
}
// MIS Report me SABKI report dekhne wale (admin ke alawa). Harsh, 17 Oct: Cssamritisharma@gmail.com.
// Email se milate hain. Aage kisi ko dena ho to yahan email jod do. Dhyan: client ko ye
// /api/me ke misAll flag se pata chalta hai (misAllowed).
const MIS_ALL_EMAILS = ['cssamritisharma@gmail.com'];
function misAllowedUser(user) {
  const em = String((user && user.email) || '').trim().toLowerCase();
  return !!em && MIS_ALL_EMAILS.includes(em);
}
async function misSeesAll(req) {
  try {
    const me = await db.findOne('Users', { id: String(req.session.userId) });
    return misAllowedUser(me);
  } catch (e) { return false; }
}
function requireAdminOrPC(req, res, next) {
  if (['admin', 'pc'].includes(req.session.role)) return next();
  res.status(403).json({ error: 'Admin or PC only' });
}

// Leaves ka pura access (sabki leaves + approve/reject) kise mile:
//  • role se — admin / pc / hr / hod
//  • ya email se — jiska email .env ke HR_EMAIL se match kare
// Email wala rasta isliye hai ki HR ka role kuch bhi ho (user bhi), use
// leaves ka access mile — role badalne ka intezaar na karna pade.
// HR ki email — .env ke HR_EMAIL se aati hai, aur DEFAULT_HR_EMAILS hamesha
// saath rehti hai taaki env set na ho ya usme typo ho to bhi HR ka access aur
// leave ki mail na ruke. (Yahi tareeka CRM me pc@raabtajewels.com ke liye
// pehle se use hota hai.)
const DEFAULT_HR_EMAILS = ['hr@raabtajewels.com'];
function hrEmailList() {
  const fromEnv = String(process.env.HR_EMAIL || '').trim().toLowerCase();
  return [...new Set([...(fromEnv ? [fromEnv] : []), ...DEFAULT_HR_EMAILS])];
}

function canManageLeaves(role, email, notificationEmail) {
  if (['admin', 'pc', 'hr', 'hod'].includes(String(role || '').trim().toLowerCase())) return true;
  const mine = [email, notificationEmail].map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
  return hrEmailList().some(hr => mine.includes(hr));
}

// Ek hi jagah se poora sach: HR_EMAIL kya set hai, kis-kis ko leave ka
// access mil raha hai aur kyun. Kuch badalta nahi — sirf batata hai.
app.get('/api/admin/leave-access', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    const users = await d.findAll('Users');
    const hrRaw = process.env.HR_EMAIL;
    const hr = String(hrRaw || '').trim().toLowerCase();
    const withAccess = users
      .filter(u => canManageLeaves(u.role, u.email, u.notification_email))
      .map(u => ({
        id: parseInt(u.id), name: u.name, email: u.email, role: u.role,
        kyun: ['admin', 'pc', 'hr', 'hod'].includes(String(u.role || '').trim().toLowerCase())
          ? `role "${u.role}" ki wajah se` : 'HR_EMAIL se match hone ki wajah se'
      }));
    res.json({
      HR_EMAIL: hrRaw === undefined ? 'SET HI NAHI HAI ❌' : `"${hrRaw}"`,
      HR_EMAIL_normalized: hr || '(khali)',
      totalUsers: users.length,
      leaveAccessWaale: withAccess,
      verdict: withAccess.length
        ? `${withAccess.length} logon ko leave ka pura access hai`
        : 'KISI ko bhi access nahi — HR_EMAIL galat hai ya kisi ka role admin/pc/hr/hod nahi'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers ──
function getTabName(type) {
  return type === 'delegation' ? 'Delegation_Tasks' : 'Checklist_Tasks';
}

function today() { return new Date().toISOString().split('T')[0]; }

// ── Checklist ki due_date: padhne se pehle seedhi kar lo ─────────────
// DB me kabhi-kabhi ulti date reh jaati hai ("30-09-2026"). App date ko
// seedha string ki tarah tolta hai, isliye "30-..." har cutoff se BADI
// nikalti hai aur wo row kabhi dikhti hi nahi. Nishant ka monthly task
// (Home Staff Salary Logs) isi wajah se July se DB me pada tha par ek baar
// bhi screen par nahi aaya. Ab compare se pehle hamesha YYYY-MM-DD bana
// lete hain, taaki aisi row chhipe nahi.
function dueIso(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return flipToIso(s) || s;
}

function isoPlusDays(iso, n) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Monthly aur quarterly task DO DIN PEHLE dikhne lagte hain -- Harsh, 6 Oct:
// "monthly ya quarterly jo bhi task ho do din pehle show ho jane chahiye".
// Mahine me ek baar aane wale kaam ke liye ek din ka notice kaafi nahi hota.
// Baaki (daily, weekly) apne hi din par, jaise pehle the.
const CHL_EARLY_FREQ = new Set(['monthly', 'quarterly']);
const CHL_EARLY_DAYS = 2;
function chlCutoff(t, todayStr) {
  const f = String(t.frequency || '').toLowerCase().trim();
  return CHL_EARLY_FREQ.has(f) ? isoPlusDays(todayStr, CHL_EARLY_DAYS) : todayStr;
}

function parseIntSafe(v) { const n = parseInt(v); return isNaN(n) ? 0 : n; }

// ══════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    await getDB();
    const { email, password } = req.body;
    const allUsers = await db.findAll('Users');
    const user = allUsers.find(u => u.email && u.email.trim().toLowerCase() === (email || '').trim().toLowerCase());
    if (!user || user.password !== password)
      return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign(
      { userId: parseInt(user.id), role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('token', token, { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ id: parseInt(user.id), name: user.name, email: user.email, role: user.role, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await db.findOne('Users', { id: String(req.session.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: parseInt(user.id),
      name: user.name,
      email: user.email,
      notification_email: user.notification_email || '',
      role: user.role,
      phone: user.phone || '',
      profile_image: user.profile_image || '',
      department: user.department || '',
      week_off: user.week_off || '',
      extra_off: user.extra_off || '',
      // Leave page ko batata hai ki sabki leaves + approve/reject dikhana hai
      canManageLeaves: canManageLeaves(user.role, user.email, user.notification_email),
      // HR Reporting tab sirf Admin + HR ko (PC/HOD ko nahi)
      hrReport: isHrReportUser(user.role, user.email, user.notification_email),
      // HR Reporting (Onboarding FMS) ka tab: HR/admin ko, aur jinka koi onboarding step hai unko
      hrOnboard: await obUserHasSteps(user),
      // Maintenance tab kis roop me dikhe — dekho maintAccessFor()
      // Gold System kise dikhe -- abhi sirf admin (goldAllowed dekho)
      goldSystem: goldAllowed(user),
      castingSystem: castingAllowed(user),
      misAll: misAllowedUser(user),
      maintView: maintAccessFor(user).view,
      maintPerson: maintAccessFor(user).person
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const db = await getDB();
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin' || role === 'pc';
    const isHod = role === 'hod';
    const filterEmployee = req.query.employee;
    const dateFrom = req.query.dateFrom || '';
    const dateTo = req.query.dateTo || '';
    const taskType = req.query.taskType || 'both';
    const todayStr = today();

    // Determine which user IDs to include
    let allowedUserIds = null; // null = all

    if (isAdmin) {
      // Admin/PC: show all, or filter by specific employee
      if (filterEmployee && filterEmployee !== 'all') {
        allowedUserIds = [String(filterEmployee)];
      }
      // else allowedUserIds stays null = show all tasks
    } else if (isHod) {
      const meUser = await db.findOne('Users', { id: String(uid) });
      const dept = meUser?.department || '';
      if (filterEmployee && filterEmployee !== 'all') {
        allowedUserIds = [String(filterEmployee)];
      } else if (dept) {
        const deptUsers = await db.findWhere('Users', { department: dept });
        allowedUserIds = deptUsers.map(u => String(u.id));
        if (!allowedUserIds.includes(String(uid))) allowedUserIds.push(String(uid));
      } else {
        allowedUserIds = [String(uid)];
      }
    } else {
      allowedUserIds = [String(uid)];
    }

    const taskFilter = (task) => {
      if (allowedUserIds && !allowedUserIds.includes(String(task.assigned_to))) return false;
      const due = task.due_date || '';
      if (dateFrom && dateTo) {
        return due >= dateFrom && due <= dateTo;
      }
      return true; // show all tasks regardless of due date
    };

    let pending = 0, revised = 0, completed = 0;
    // Pie chart ke liye alag ginti -- niche dekho
    let pendingDue = 0;
    let delegationPending = [], checklistPending = [];

    // Fetch all needed tabs in parallel (promise coalescing prevents duplicate API calls)
    const fetchDel = (taskType === 'delegation' || taskType === 'both') ? db.findAll('Delegation_Tasks') : Promise.resolve([]);
    const fetchChl = (taskType === 'checklist'  || taskType === 'both') ? db.findAll('Checklist_Tasks')  : Promise.resolve([]);
    const fetchUsr = db.findAll('Users');
    const [allDel, allChl, allUsers] = await Promise.all([fetchDel, fetchChl, fetchUsr]);

    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    if (taskType === 'delegation' || taskType === 'both') {
      for (const t of allDel) {
        if (!taskFilter(t)) continue;
        if (t.status === 'pending') {
          pending++;
          // Pie ke liye: sirf wo pending jinki date aaj ki hai ya nikal chuki
          // hai. Aage ki date wale (upcoming) ismein nahi aate -- Harsh, 9 Oct:
          // "pie me bass current aur overdue dikhao, upcoming mat karwao".
          // Bina date wale task ko current hi maante hain, wo kabhi "aage ka"
          // nahi hota. dueIso isliye ki ulti likhi date bhi theek padhi jaye.
          if (!t.due_date || dueIso(t.due_date) <= todayStr) pendingDue++;
        }
        else if (t.status === 'revised') revised++;
        else if (t.status === 'completed' || t.status === 'closed') completed++;
        // Delegation: due date chahe aage ki ho, task assign hote hi dashboard
        // me dikhta hai — doer ko pata rehta hai ki kya aa raha hai.
        // (Checklist alag hai — wo daily recurring hai, isliye wahan sirf aaj
        // tak wale dikhte hain, warna saal bhar ke rows dashboard bhar dete.)
        if (t.status === 'pending' || t.status === 'revised') {
          delegationPending.push({
            id: parseInt(t.id), type: 'delegation',
            description: t.description, status: t.status,
            assigned_to: parseInt(t.assigned_to),
            priority: t.priority || 'low',
            approval: t.approval || 'no',
            waiting_approval: parseInt(t.waiting_approval) || 0,
            remarks: t.remarks || '',
            due_date: t.due_date || '',
            assignedToName: userMap[String(t.assigned_to)]?.name || '',
            assignedByName: userMap[String(t.assigned_by)]?.name || ''
          });
        }
      }
    }

    if (taskType === 'checklist' || taskType === 'both') {
      for (const t of allChl) {
        if (!taskFilter(t)) continue;
        if (t.status === 'pending') {
          pending++;
          // Pie ke liye: sirf wo pending jinki date aaj ki hai ya nikal chuki
          // hai. Aage ki date wale (upcoming) ismein nahi aate -- Harsh, 9 Oct:
          // "pie me bass current aur overdue dikhao, upcoming mat karwao".
          // Bina date wale task ko current hi maante hain, wo kabhi "aage ka"
          // nahi hota. dueIso isliye ki ulti likhi date bhi theek padhi jaye.
          if (!t.due_date || dueIso(t.due_date) <= todayStr) pendingDue++;
        }
        else if (t.status === 'revised') revised++;
        else if (t.status === 'completed' || t.status === 'closed') completed++;
        // Dashboard table: aaj tak ke (ya pichhle) task. Monthly/quarterly
        // do din pehle se. Date ulti likhi ho to bhi chhipti nahi -- dueIso.
        if (t.status === 'pending' && (!t.due_date || dueIso(t.due_date) <= chlCutoff(t, todayStr))) {
          checklistPending.push({
            id: parseInt(t.id), type: 'checklist',
            description: t.description, status: t.status,
            assigned_to: parseInt(t.assigned_to),
            priority: t.priority || 'low',
            approval: 'no', waiting_approval: 0,
            remarks: t.remarks || '',
            due_date: t.due_date || '',
            assignedToName: userMap[String(t.assigned_to)]?.name || '',
            assignedByName: userMap[String(t.assigned_by)]?.name || ''
          });
        }
      }
    }

    res.json({
      pending, revised, completed, pendingDue,
      todayPending: [...delegationPending, ...checklistPending],
      // separate counts for backward compat
      delegationPending: delegationPending.length,
      delegationRevised: revised,
      delegationCompleted: completed,
      checklistPending: checklistPending.length,
      checklistRevised: 0,
      checklistCompleted: 0,
      delegationTodayPending: delegationPending,
      checklistTodayPending: checklistPending
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    const isAdmin = role === 'admin';
    const isHod = role === 'hod';
    const { type, mine } = req.query;
    const isMine = (mine === '1' || mine === 'true');
    const tabName = getTabName(type || 'delegation');
    const isDeleg = (type || 'delegation') === 'delegation';
    const includeFuture = req.query.includeFuture === '1' || req.query.includeFuture === 'true';
    const todayStr = today();

    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    let allowedUserIds = null;
    if (isMine) {
      // no user filter — filter by assigned_by below
    } else if (isAdmin || role === 'pc') {
      allowedUserIds = null; // all
    } else if (isHod) {
      const meUser = await db.findOne('Users', { id: String(uid) });
      const dept = meUser?.department || '';
      const deptUsers = dept ? (await db.findAll('Users')).filter(u => u.department === dept) : [];
      if (!deptUsers.length) return res.json({ grouped: [] });
      allowedUserIds = deptUsers.map(u => String(u.id));
    } else {
      allowedUserIds = [String(uid)];
    }

    // Har task ke do khaas mode: DONE kisne kiya (report/completed me le gaya)
    // aur CLOSE kisne kiya. Ek hi baar poora log padh kar map bana lete hain,
    // har task par alag query nahi.
    const doneMap = {}, closeMap = {};
    try {
      const log = await db.findAll('Task_Status_Log');
      log.sort((a, b) => String(a.changed_at || '').localeCompare(String(b.changed_at || '')));
      log.forEach(l => {
        if (String(l.task_type || '') !== (type || 'delegation')) return;
        const k = String(l.task_id);
        const ko = String(l.to_status || '');
        const kisne = { by: l.by_name || '', at: l.changed_at || '' };
        // baad wali entry pehle wali ko badal degi -- yaani sabse naya wala
        if (ko === 'report' || ko === 'completed') doneMap[k] = kisne;
        else if (ko === 'closed') closeMap[k] = kisne;
      });
    } catch { /* log table abhi bani nahi -- koi baat nahi */ }

    // Har task par kitne comment hain. 💬 button par chhoti si ginti
    // dikhani hai, taaki ek nazar me pata chale ki kisi task par baat hui
    // hai -- pehle button khole bina pata hi nahi chalta tha ki andar kuch
    // likha hai ya nahi. (Harsh, 18 Sep 2026)
    // Poori table EK baar padh kar map bana lete hain -- har task par alag
    // query nahi.
    const cmtMap = {};
    try {
      const cmts = await db.findAll('Task_Comments');
      cmts.forEach(c => {
        if (String(c.task_type || '') !== (type || 'delegation')) return;
        const k = String(c.task_id);
        cmtMap[k] = (cmtMap[k] || 0) + 1;
      });
    } catch { /* table na ho to ginti 0 rahegi -- list phir bhi chalegi */ }

    const allTasks = await db.findAll(tabName);

    const tasks = allTasks.filter(t => {
      if (isMine) {
        return String(t.assigned_by) === String(uid);
      }
      // Approval-pending naya task: doer ko tabhi dikhe jab approve ho jaye
      if (t.status === 'waiting_approval' && !isAdmin && role !== 'pc') return false;
      if (allowedUserIds && !allowedUserIds.includes(String(t.assigned_to))) return false;
      if (!isDeleg && !includeFuture && dueIso(t.due_date) > chlCutoff(t, todayStr)) return false;
      return true;
    }).map(t => ({
      id: parseInt(t.id),
      type: type || 'delegation',
      description: t.description,
      status: t.status,
      assigned_to: parseInt(t.assigned_to),
      assigned_by: parseInt(t.assigned_by),
      priority: t.priority || 'low',
      approval: isDeleg ? (t.approval || 'no') : 'no',
      waiting_approval: isDeleg ? (parseInt(t.waiting_approval) || 0) : 0,
      remarks: t.remarks || '',
      due_date: t.due_date || '',
      assigned_on: t.created_at ? t.created_at.split('T')[0].split(' ')[0] : '',
      frequency: t.frequency || '',
      // Attachments ki actual base64 list me NAHI bhejte (bahut bhaari) — sirf
      // flag ki file hai ya nahi. Actual file /attachments endpoint se aati hai.
      hasAttachments: isDeleg ? !!(t.attachments && String(t.attachments).length > 5) : false,
      report_note: isDeleg ? (t.report_note || '') : '',
      was_reported: isDeleg ? (parseInt(t.was_reported) || 0) : 0,
      // Status kisne aur kab badla. DB me ye 12 Sep se likha ja raha tha par
      // screen par kahin dikhta nahi tha -- isliye har band task dekh kar
      // lagta tha "apne aap ho gaya". Ab list me saath dikhega.
      statusChangedAt: t.status_changed_at || '',
      statusChangedByName: t.status_changed_by_name
        || (t.status_changed_by ? (userMap[String(t.status_changed_by)]?.name || '') : ''),
      // Safar ke do padav alag-alag -- taaki "Done kisne kiya" baad me koi
      // close kar de to bhi gum na ho
      doneByName: (doneMap[String(t.id)] || {}).by || '',
      doneAt: (doneMap[String(t.id)] || {}).at || '',
      closedByName: (closeMap[String(t.id)] || {}).by || '',
      closedAt: (closeMap[String(t.id)] || {}).at || '',
      commentCount: cmtMap[String(t.id)] || 0,
      assignedToName: userMap[String(t.assigned_to)]?.name || '',
      assignedByName: userMap[String(t.assigned_by)]?.name || ''
    })).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));

    if (isMine) return res.json({ tasks });
    if (isAdmin || isHod || role === 'pc') {
      const grouped = {};
      tasks.forEach(t => {
        const k = String(t.assigned_to);
        if (!grouped[k]) grouped[k] = { userId: t.assigned_to, name: t.assignedToName, tasks: [] };
        grouped[k].tasks.push(t);
      });
      return res.json({ grouped: Object.values(grouped) });
    }
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PC tab kaun dekh sakta hai. Admin ko hamesha; aur in emails ko, chahe
// unka role normal 'user' ho. Naya banda dena ho to bas yahan naam jodo
// (frontend ki list bhi isi ke saath badalni hai — PC_EMAILS).
// Harsh, 9 Sep 2026: Nishant ko bhi PC tab dena hai.
const PC_EMAILS = ['pc@raabtajewels.com', 'nishant@raabtajewels.com'];

// CRM data — SABHI doers ke pending/revised tasks (delegation + checklist).
app.get('/api/crm/tasks', requireAuth, async (req, res) => {
  try {
    let allowed = req.session.role === 'admin';
    if (!allowed) {
      const me = await db.findOne('Users', { id: String(req.session.userId) });
      allowed = PC_EMAILS.includes((me?.email || '').trim().toLowerCase());
    }
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });

    const [del, chl, users] = await Promise.all([
      db.findAll('Delegation_Tasks'), db.findAll('Checklist_Tasks'), db.findAll('Users')
    ]);
    const userMap = {};
    for (const u of users) userMap[String(u.id)] = u;
    const shape = (t, taskType) => ({
      id: parseInt(t.id), taskType,
      description: t.description, status: t.status,
      priority: t.priority || 'low', due_date: t.due_date || '',
      assignedToName: userMap[String(t.assigned_to)]?.name || '',
      assignedByName: userMap[String(t.assigned_by)]?.name || ''
    });
    const isOpen = t => t.status === 'pending' || t.status === 'revised';
    const tasks = [
      ...del.filter(isOpen).map(t => shape(t, 'delegation')),
      ...chl.filter(isOpen).map(t => shape(t, 'checklist'))
    ];
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Logged-in user's own PENDING checklist tasks due within the next 2 days
// (drives the dashboard notification bell — "2 din pehle" advance reminder).
// Includes overdue + today + next 2 days.
// ══ ALERTS_ROUTE_START ══
// Chrome notification ke liye: pichhli baar ke baad mere liye kya NAYA aaya --
// naya delegation / checklist task, approval ki request, transfer ki request,
// ya koi task mujhe transfer hua. (Harsh, 21 Oct)
// Client har table ka "aakhri dekha hua id" bhejta hai; jo usse aage hai wahi
// naya hai. Pehli baar (id na bheja ho) sirf aaj ke max id lautate hain, taaki
// app kholte hi purane task ki baarish na ho.
// MySQL par sirf zaroori columns aur "id > X" wali rows padhte hain -- har
// 30 sec poori table (attachments samet) kheenchna bhaari padta.
async function alertMaxId(table) {
  if (db && db.pool) {
    const [r] = await db.pool.query('SELECT MAX(id) AS m FROM `' + table + '`');
    return parseInt(r[0] && r[0].m) || 0;
  }
  return (await db.findAll(table)).reduce((m, r) => Math.max(m, parseInt(r.id) || 0), 0);
}
async function alertRows(table, cols, sinceId, where, params, jsFilter) {
  if (db && db.pool) {
    const [rows] = await db.pool.query(
      'SELECT ' + cols.map(c => '`' + c + '`').join(', ') + ' FROM `' + table + '` WHERE id > ?' +
      (where ? ' AND ' + where : '') + ' ORDER BY id ASC LIMIT 1000', [sinceId].concat(params || []));
    return rows.map(r => { const o = {}; cols.forEach(c => { o[c] = r[c] == null ? '' : String(r[c]); }); return o; });
  }
  return (await db.findAll(table)).filter(r => (parseInt(r.id) || 0) > sinceId && jsFilter(r));
}
async function alertDescs(type, ids) {
  const table = type === 'checklist' ? 'Checklist_Tasks' : 'Delegation_Tasks';
  const out = {};
  const uniq = [...new Set(ids.map(String))].filter(Boolean);
  if (!uniq.length) return out;
  if (db && db.pool) {
    const [rows] = await db.pool.query('SELECT id, description FROM `' + table + '` WHERE id IN (?)', [uniq]);
    rows.forEach(r => { out[String(r.id)] = String(r.description || ''); });
    return out;
  }
  for (const id of uniq) { const t = await db.findOne(table, { id }); out[id] = (t && t.description) || ''; }
  return out;
}

app.get('/api/my-alerts', requireAuth, async (req, res) => {
  try {
    const uid = String(req.session.userId);
    const role = req.session.role;
    const num = v => { const x = parseInt(v, 10); return Number.isInteger(x) && x >= 0 ? x : null; };
    const since = { del: num(req.query.del), chl: num(req.query.chl), apr: num(req.query.apr), trf: num(req.query.trf) };
    const canTransfer = role === 'admin' || role === 'hod' || role === 'pc';

    const max = {
      del: await alertMaxId('Delegation_Tasks'),
      chl: await alertMaxId('Checklist_Tasks'),
      apr: await alertMaxId('Task_Approvals'),
      trf: await alertMaxId('Task_Transfers').catch(() => 0)
    };
    // Mujhe transfer hue task (approve hone par) -- inka id purana hota hai,
    // isliye client inhe alag se "dekhe hue" ki list se milata hai
    let tin = [];
    try {
      if (db && db.pool) {
        const [rows] = await db.pool.query("SELECT id, task_id, task_type, from_user FROM `Task_Transfers` WHERE status = 'approved' AND to_user = ? ORDER BY id DESC LIMIT 20", [uid]);
        tin = rows.map(r => ({ id: String(r.id), task_id: String(r.task_id), task_type: String(r.task_type), from_user: String(r.from_user) }));
      } else {
        tin = (await db.findAll('Task_Transfers')).filter(t => t.status === 'approved' && String(t.to_user) === uid)
          .sort((a, b) => parseInt(b.id) - parseInt(a.id)).slice(0, 20);
      }
    } catch (e) { tin = []; }

    // Pehli baar: sirf baseline
    if (since.del === null || since.chl === null || since.apr === null || since.trf === null) {
      return res.json({ max, items: [], tin: tin.map(t => String(t.id)) });
    }

    const users = await db.findAll('Users');
    const nameOf = id => (users.find(u => String(u.id) === String(id)) || {}).name || '';
    const items = [];

    // 1) Naye delegation task -- mujhe diye gaye, kisi aur ne diye
    const del = await alertRows('Delegation_Tasks', ['id', 'description', 'due_date', 'priority', 'assigned_by', 'assigned_to', 'status'],
      since.del, 'assigned_to = ? AND assigned_by <> ?', [uid, uid],
      t => String(t.assigned_to) === uid && String(t.assigned_by) !== uid);
    del.filter(t => (t.status || 'pending') === 'pending').forEach(t => items.push({
      kind: 'delegation', id: parseInt(t.id), description: t.description, due_date: t.due_date,
      priority: t.priority || 'low', byName: nameOf(t.assigned_by)
    }));

    // 2) Naye checklist task -- ek saath kai bante hain, isliye naam ke hisaab se ek
    const chl = await alertRows('Checklist_Tasks', ['id', 'description', 'due_date', 'frequency', 'assigned_by', 'assigned_to', 'status'],
      since.chl, 'assigned_to = ? AND assigned_by <> ?', [uid, uid],
      t => String(t.assigned_to) === uid && String(t.assigned_by) !== uid);
    const groups = {};
    chl.forEach(t => {
      const k = (t.description || '') + '|' + (t.assigned_by || '');
      if (!groups[k]) groups[k] = { kind: 'checklist', id: parseInt(t.id), description: t.description, frequency: t.frequency || '',
        first_due: t.due_date, count: 0, byName: nameOf(t.assigned_by) };
      groups[k].count++;
      if (t.due_date && (!groups[k].first_due || t.due_date < groups[k].first_due)) groups[k].first_due = t.due_date;
    });
    Object.values(groups).forEach(g => items.push(g));

    // 3) Approval ki request -- wahi jo mere Approvals page par aati (admin/PC ko sab)
    const apr = await alertRows('Task_Approvals', ['id', 'task_id', 'task_type', 'requested_by', 'requested_to', 'action_type', 'status'],
      since.apr, "status = 'pending'", [], t => t.status === 'pending');
    const myApr = apr.filter(a => role === 'admin' || role === 'pc' || String(a.requested_to) === uid)
      .filter(a => String(a.requested_by) !== uid);
    if (myApr.length) {
      const dd = await alertDescs('delegation', myApr.filter(a => a.task_type !== 'checklist').map(a => a.task_id));
      const cd = await alertDescs('checklist', myApr.filter(a => a.task_type === 'checklist').map(a => a.task_id));
      myApr.forEach(a => items.push({
        kind: 'approval', id: parseInt(a.id), action_type: a.action_type,
        description: (a.task_type === 'checklist' ? cd : dd)[String(a.task_id)] || '',
        byName: nameOf(a.requested_by)
      }));
    }

    // 4) Transfer ki request -- admin ko sab, HOD/PC ko apne department ki
    if (canTransfer) {
      let trf = await alertRows('Task_Transfers', ['id', 'task_id', 'task_type', 'from_user', 'to_user', 'requested_by', 'status'],
        since.trf, "status = 'pending'", [], t => t.status === 'pending').catch(() => []);
      trf = trf.filter(t => String(t.requested_by) !== uid);
      if (role !== 'admin') {
        const dept = (users.find(u => String(u.id) === uid) || {}).department || '';
        const deptIds = users.filter(u => u.department === dept).map(u => String(u.id));
        trf = trf.filter(t => deptIds.includes(String(t.from_user)) || deptIds.includes(String(t.to_user)));
      }
      if (trf.length) {
        const dd = await alertDescs('delegation', trf.filter(t => t.task_type !== 'checklist').map(t => t.task_id));
        const cd = await alertDescs('checklist', trf.filter(t => t.task_type === 'checklist').map(t => t.task_id));
        trf.forEach(t => items.push({
          kind: 'transfer', id: parseInt(t.id),
          description: (t.task_type === 'checklist' ? cd : dd)[String(t.task_id)] || '',
          fromName: nameOf(t.from_user), toName: nameOf(t.to_user)
        }));
      }
    }

    // 5) Mujhe transfer hue task -- client batata hai kaunse pehle dekh chuka
    const seenTin = new Set(String(req.query.tin || '').split(',').filter(Boolean));
    const newTin = tin.filter(t => !seenTin.has(String(t.id)));
    if (newTin.length && req.query.tin !== undefined) {
      const dd = await alertDescs('delegation', newTin.filter(t => t.task_type !== 'checklist').map(t => t.task_id));
      const cd = await alertDescs('checklist', newTin.filter(t => t.task_type === 'checklist').map(t => t.task_id));
      newTin.forEach(t => items.push({
        kind: 'transfer-in', id: parseInt(t.id),
        description: (t.task_type === 'checklist' ? cd : dd)[String(t.task_id)] || '',
        fromName: nameOf(t.from_user)
      }));
    }

    res.json({ max, items, tin: tin.map(t => String(t.id)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ══ ALERTS_ROUTE_END ══

app.get('/api/my-checklist-reminders', requireAuth, async (req, res) => {
  try {
    const uid = String(req.session.userId);
    const role = req.session.role;
    const todayStr = today();
    const cutoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const [all, users] = await Promise.all([db.findAll('Checklist_Tasks'), db.findAll('Users')]);
    const userMap = {};
    for (const u of users) userMap[String(u.id)] = u;

    // Whose checklists to include: admin/pc → everyone, hod → own dept, user → own only.
    let allowed = null; // null = all
    if (role === 'hod') {
      const dept = userMap[uid]?.department || '';
      allowed = new Set(users.filter(u => u.department === dept).map(u => String(u.id)));
    } else if (role !== 'admin' && role !== 'pc') {
      allowed = new Set([uid]);
    }

    const tasks = all
      .filter(t => (t.status === 'pending' || !t.status) && t.due_date && t.due_date <= cutoff
        && (allowed === null || allowed.has(String(t.assigned_to))))
      .map(t => ({
        id: parseInt(t.id),
        description: t.description,
        due_date: t.due_date,
        priority: t.priority || 'low',
        frequency: t.frequency || '',
        assignedToName: userMap[String(t.assigned_to)]?.name || '',
        mine: String(t.assigned_to) === uid
      }))
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    res.json({ tasks, today: todayStr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { type, desc, assignedTo, approverEmail, approverId, date: rawDate, priority, approval, remarks } = req.body;
    if (!desc || !rawDate) return res.status(400).json({ error: 'Description and date required' });
    // Date hamesha YYYY-MM-DD me hi DB me jaye (12 Sep 2026 ka fix)
    const date = toIsoDateSrv(rawDate);
    if (!date) return res.status(400).json({ error: `Date theek nahi hai: "${rawDate}" — YYYY-MM-DD ya DD-MM-YYYY me do` });
    const role = req.session.role;
    const targetUser = (role === 'admin' || role === 'hod' || role === 'user') && assignedTo
      ? String(parseInt(assignedTo)) : String(req.session.userId);

    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];

    if ((type || 'checklist') === 'delegation') {
      let assignedBy = String(req.session.userId);
      if (approverEmail) {
        const allUsers = await db.findAll('Users');
        const aprUser = allUsers.find(u => u.email && u.email.trim().toLowerCase() === (approverEmail || '').trim().toLowerCase());
        if (aprUser) assignedBy = String(aprUser.id);
      }
      // Approval task: doer ko task TURANT dikhta hai (normal pending). Approval
      // COMPLETION par lagta hai — doer Done kare to request approver ke paas
      // jaati hai (PUT /status ka existing needsApproval flow), approve hone par
      // hi task Completed hota hai. Chosen approver assigned_by me store hota hai
      // kyunki completion-approval request usi (assigned_by) ke paas jaati hai.
      if (approval === 'yes' && approverId) {
        assignedBy = String(parseInt(approverId));
      }
      await db.insert('Delegation_Tasks', {
        description: desc, assigned_to: targetUser, assigned_by: assignedBy,
        due_date: date, status: 'pending', priority: priority || 'low',
        approval: approval || 'no', waiting_approval: '0', remarks: remarks || '',
        frequency: '', last_reminder_date: '', created_at: nowStr
      });
      // Non-blocking notifications — WhatsApp and email fire INDEPENDENTLY so a
      // slow SMTP send can never delay the WhatsApp (it goes within ~1-2 sec).
      (async () => {
        const assigner = await db.findOne('Users', { id: assignedBy });
        const assignerName = assigner?.name || 'Admin';
        // WhatsApp — fire immediately, don't wait for email
        // (WA.notifyOnAssign false ho to assign-time message bilkul nahi jaata)
        if (WA.notifyOnAssign) getWhatsAppTarget(parseInt(targetUser)).then(waTarget => {
          if (!waTarget) return;
          return queueWhatsApp(waTarget.phone, waDelegationMsg({
            assigneeName: waTarget.name, assignerName,
            desc, dueDate: date,
            priority: priority || 'low', approval: approval || 'no', remarks: remarks || ''
          }), 'assign-delegation', '', waTarget.name);
        }).catch(e => console.error('  WA notify error:', e.message));

        // Approver ko bhi — sirf jab approval 'yes' ho aur koi approver
        // chuna gaya ho. Approver hi doer ho to dobara nahi bhejte (usse
        // pehle hi upar wala message ja chuka hai).
        if (WA.notifyOnAssign && approval === 'yes' && approverId
            && String(parseInt(approverId)) !== String(targetUser)) {
          (async () => {
            const doer = await db.findOne('Users', { id: String(targetUser) });
            const creator = await db.findOne('Users', { id: String(req.session.userId) });
            const waApr = await getWhatsAppTarget(parseInt(approverId));
            if (!waApr) return;
            await queueWhatsApp(waApr.phone, waApproverMsg({
              approverName: waApr.name,
              doerName: (doer && doer.name) || '',
              assignerName: (creator && creator.name) || 'Admin',
              desc, dueDate: date, priority: priority || 'low', remarks: remarks || ''
            }), 'assign-approver', '', waApr.name);
          })().catch(e => console.error('  WA approver notify error:', e.message));
        }

        // Email — in parallel
        getNotifyTarget(parseInt(targetUser)).then(target => {
          if (!target) return;
          // BAND (Harsh, 11 Sep): task assign ki mail nahi jaati, sirf WhatsApp
          return sendMail(
            target.email,
            `New Task Assigned: ${(desc || '').slice(0, 60)}`,
            delegationEmailHtml({
              assigneeName: target.name, assignerName,
              desc, dueDate: date,
              priority: priority || 'low', approval: approval || 'no', remarks: remarks || ''
            }),
            'task-assign'
          );
        }).catch(e => console.error('  Email notify error:', e.message));
      })();
    } else {
      await db.insert('Checklist_Tasks', {
        description: desc, assigned_to: targetUser, assigned_by: String(req.session.userId),
        due_date: date, status: 'pending', priority: priority || 'low',
        remarks: remarks || '', frequency: '', created_at: nowStr,
        doer_name: await doerNameFor(targetUser)
      });
      // Non-blocking WhatsApp to the assignee (assign-time — WA.notifyOnAssign se control)
      if (WA.notifyOnAssign) (async () => {
        const waTarget = await getWhatsAppTarget(parseInt(targetUser));
        if (waTarget) {
          await queueWhatsApp(waTarget.phone, waChecklistMsg({
            assigneeName: waTarget.name, desc, dueText: date, count: 1
          }), 'assign-checklist', '', waTarget.name);
        }
      })();
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// due_date sirf asli YYYY-MM-DD ho — "NaN-NaN-NaN", "abc", 31-02 kuch nahi.
// 7 Sep 2026: browser se NaN wali date aa gayi thi aur 168 rows kharab ban
// gayi thin. Ab aakhri taala yahan hai — client me bug ho tab bhi DB saaf.
// Date ko hamesha YYYY-MM-DD me badlo. "12-09-2026" / "12/09/2026" (DD pehle)
// bhi chalega. Samajh na aaye to khali -- phir caller mana kar dega.
// 12 Sep 2026: 26 nayi rows phir se "12-09-2026" jaisi ban gayi thin, kyunki
// single-task banane aur edit karne wale raaste date ko bina dekhe DB me daal
// dete the. Poora app date ko YYYY-MM-DD maan kar SEEDHE compare karta hai
// (sort, overdue, reminder ka cutoff), isliye ulti date hisaab bigaad deti hai.
function toIsoDateSrv(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  let y, mo, da;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { y = +m[1]; mo = +m[2]; da = +m[3]; }
  else {
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);   // DD-MM-YYYY
    if (!m) return '';
    da = +m[1]; mo = +m[2]; y = +m[3];
  }
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
}

function isRealDate(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = +m[1], mo = +m[2], da = +m[3];
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || da < 1 || da > 31) return false;
  const d = new Date(Date.UTC(y, mo - 1, da));
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da;
}

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await getDB();
    const { desc, assignedTo, priority, remarks, dates: rawDates, frequency } = req.body;
    if (!desc || !assignedTo || !rawDates || !rawDates.length) return res.status(400).json({ error: 'Missing fields' });
    const dates = rawDates.filter(isRealDate);
    if (!dates.length) {
      return res.status(400).json({
        error: 'Date theek nahi hai — koi bhi task nahi banaya. Start date DD-MM-YYYY ya YYYY-MM-DD me do.'
      });
    }
    const freq = (frequency || '').toLowerCase().trim();
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    const doerNm = await doerNameFor(assignedTo);
    const rows = dates.map(date => ({
      description: desc, assigned_to: String(parseInt(assignedTo)),
      assigned_by: String(req.session.userId), due_date: date,
      status: 'pending', priority: priority || 'low',
      remarks: remarks || '', frequency: freq, created_at: nowStr,
      doer_name: doerNm
    }));
    await db.batchInsert('Checklist_Tasks', rows);
    // Non-blocking WhatsApp — one summary message to the assignee
    // (assign-time — WA.notifyOnAssign false ho to skip)
    if (WA.notifyOnAssign) (async () => {
      const waTarget = await getWhatsAppTarget(parseInt(assignedTo));
      if (!waTarget) return;
      const sorted = [...dates].sort();
      const dueText = dates.length > 1
        ? `${dates.length} dates (${sorted[0]} … ${sorted[sorted.length - 1]})`
        : sorted[0];
      await queueWhatsApp(waTarget.phone, waChecklistMsg({
        assigneeName: waTarget.name, desc, dueText, count: dates.length
      }), 'assign-checklist-bulk', '', waTarget.name);
    })();
    res.json({ success: true, count: dates.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, type, newDate, reason } = req.body;
    const tabName = getTabName(type || 'delegation');
    const isAdmin = req.session.role === 'admin';
    const isPC = req.session.role === 'pc';
    const uid = req.session.userId;
    const task = await db.findOne(tabName, { id: req.params.id });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!isAdmin && !isPC && String(task.assigned_to) !== String(uid))
      return res.status(403).json({ error: 'Not allowed' });

    // ── DONE SIRF DOER KAR SAKTA HAI ──
    // Harsh (17 Sep 2026): "ab se auto task nahi honge, only doer hi kar
    // sakta hai."
    // Pehle admin/PC kisi ka bhi task Done kar sakte the. Isse baar-baar ye
    // sawaal uthta tha ki "task bina kiye Done kaise ho gaya" -- kaam kisi ne
    // kiya nahi hota tha, par status Done ho jaata tha.
    // Ab Done (delegation me 'report', checklist me 'completed') SIRF wahi
    // banda laga sakta hai jise task mila hai. Admin ka baaki kaam waisa hi
    // rehta hai -- Close, Reopen, Revise sab kar sakta hai; bas doosre ki
    // taraf se "ho gaya" nahi keh sakta.
    const doneWaliStatus = (status === 'report' || status === 'completed');
    if (doneWaliStatus && String(task.assigned_to) !== String(uid)) {
      return res.status(403).json({
        error: 'Only the doer can mark this task Done. You can Close or Revise it instead.'
      });
    }

    const waitingApproval = parseInt(task.waiting_approval) || 0;

    // Proof/attachments (image/PDF base64 + note) — kisi bhi complete/report ke
    // saath aa sakte hain, isliye har upd me merge karte hain.
    const attUpd = {};
    if (typeof req.body.attachments === 'string') attUpd.attachments = req.body.attachments;
    if (typeof req.body.reportNote === 'string') attUpd.report_note = req.body.reportNote;

    // REPORT flow: doer delegation task "Done" kare to seedha completed nahi,
    // balki 'report' status me jaata hai — admin Report tab me review karta hai.
    if (status === 'report') {
      // APPROVAL wala task: doer ka "Done" pehle APPROVER ke paas jaata hai
      // (approver = assigned_by, wahi jo assign karte waqt chuna gaya tha).
      // Approver approve kare tabhi task Report tab me aata hai.
      const reportNeedsApproval = type === 'delegation' && task.approval === 'yes' && !isAdmin && !isPC;
      if (reportNeedsApproval) {
        const existing = await db.findWhere('Task_Approvals', { task_id: req.params.id, task_type: type, status: 'pending' });
        if (existing.length) return res.status(400).json({ error: 'Approval already pending' });
        const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
        await db.insert('Task_Approvals', {
          task_id: req.params.id, task_type: type,
          requested_by: String(uid), requested_to: task.assigned_by,
          action_type: 'report', status: 'pending',
          note: req.body.reportNote || '', created_at: nowStr
        });
        // Attachments abhi save kar lo — approve hone par yehi Report me dikhenge
        await db.update(tabName, req.params.id, { waiting_approval: '1', ...attUpd });
        return res.json({ success: true, needsApproval: true });
      }
      // was_reported: Reopen ke baad Pending me row highlight karne ke liye
      await db.update(tabName, req.params.id, stamp(req, { status: 'report', waiting_approval: '0', was_reported: '1', ...attUpd }));
      await logStatusChange(req, type, req.params.id, task.status, 'report');
      return res.json({ success: true });
    }

    if (status === 'completed' && waitingApproval) {
      // Cancel pending approvals
      const pendingApprovals = await db.findWhere('Task_Approvals', { task_id: req.params.id, task_type: type, status: 'pending' });
      for (const a of pendingApprovals) await deleteRow('Task_Approvals', a.id);
      const upd = stamp(req, { status: 'completed', ...attUpd });
      if (type === 'delegation') upd.waiting_approval = '0';
      await db.update(tabName, req.params.id, upd);
      await logStatusChange(req, type, req.params.id, task.status, 'completed');
      return res.json({ success: true, needsApproval: false });
    }

    const needsApproval = type === 'delegation' && task.approval === 'yes';
    if (needsApproval && !isAdmin && !isPC) {
      const existing = await db.findWhere('Task_Approvals', { task_id: req.params.id, task_type: type, status: 'pending' });
      if (existing.length) return res.status(400).json({ error: 'Approval already pending' });
      const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
      await db.insert('Task_Approvals', {
        task_id: req.params.id, task_type: type,
        requested_by: String(uid), requested_to: task.assigned_by,
        action_type: status, status: 'pending', note: reason || '', created_at: nowStr
      });
      const upd = { waiting_approval: '1' };
      if (newDate && status === 'revised') upd.due_date = newDate;
      await db.update(tabName, req.params.id, upd);
      return res.json({ success: true, needsApproval: true });
    }

    const upd = stamp(req, { status, ...attUpd });
    if (type === 'delegation') upd.waiting_approval = '0';
    if (newDate && status === 'revised') upd.due_date = newDate;
    await db.update(tabName, req.params.id, upd);
    await logStatusChange(req, type, req.params.id, task.status, status);
    res.json({ success: true, needsApproval: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ek delegation task ke attachments (image/pdf base64) — on-demand, kyunki
// bahut bhaari hote hain. Admin/HOD/PC ya wahi doer dekh sakta hai.
app.get('/api/tasks/:id/attachments', requireAuth, async (req, res) => {
  try {
    const task = await db.findOne('Delegation_Tasks', { id: req.params.id });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const role = req.session.role;
    const allowed = role === 'admin' || role === 'hod' || role === 'pc'
      || String(task.assigned_to) === String(req.session.userId);
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    let att = {};
    try { att = JSON.parse(task.attachments || '{}'); } catch (e) { att = {}; }
    res.json({ attachments: att, note: task.report_note || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/:id/detail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const tabName = getTabName(type || 'delegation');
    const task = await db.findOne(tabName, { id: req.params.id });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: { ...task, id: parseInt(task.id) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Status badalte waqt saath me ye bhi likho: kab, kisne. Pehle ye kahin
// record hi nahi hota tha, isliye "task auto Done kaise ho gaya" ka jawab
// dena namumkin tha (Harsh, 12 Sep 2026).
function stamp(req, extra) {
  return Object.assign({
    status_changed_at: new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0],
    status_changed_by: String((req && req.session && req.session.userId) || ''),
    status_changed_by_name: String((req && req.session && req.session.name) || '')
  }, extra || {});
}

// Har status badlav ki alag row. stamp() sirf AAKHRI badlav rakhta hai (agla
// badlav pichhle ko mita deta hai), isliye "pending se done kisne kiya" ka
// jawab gum ho jaata tha jab baad me kisi ne close kar diya. Ye log kabhi
// kuch mitata nahi -- poora safar rehta hai.
// Log likhna FAIL ho jaye to bhi task ka kaam rukna nahi chahiye, isliye
// poora try/catch me hai. (Harsh, 17 Sep 2026)
async function logStatusChange(req, taskType, taskId, fromStatus, toStatus) {
  try {
    if (!toStatus || String(fromStatus) === String(toStatus)) return;
    await db.insert('Task_Status_Log', {
      task_id: String(taskId), task_type: String(taskType || 'delegation'),
      from_status: String(fromStatus || ''), to_status: String(toStatus),
      by_user: String((req && req.session && req.session.userId) || ''),
      by_name: String((req && req.session && req.session.name) || ''),
      changed_at: new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0]
    });
  } catch (e) {
    console.error('  status log likhna fail (task chalta rahega):', e.message);
  }
}

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, desc, date: rawDate, priority, approval, remarks, assignedTo } = req.body;
    const tabName = getTabName(type || 'delegation');
    // Edit se bhi ulti date andar na aaye (12 Sep 2026 ka fix)
    const date = toIsoDateSrv(rawDate);
    if (!date) return res.status(400).json({ error: `Date theek nahi hai: "${rawDate}" — YYYY-MM-DD ya DD-MM-YYYY me do` });
    const upd = { description: desc, due_date: date, remarks: remarks || '' };
    if (type === 'delegation') { upd.priority = priority || 'low'; upd.approval = approval || 'no'; }
    // DOER BADALNA (15 Sep 2026): pehle ye endpoint assignedTo padhta hi nahi
    // tha aur Edit modal me Doer ka field bhi nahi tha -- yaani task ka doer
    // badalne ka koi rasta hi nahi tha. Isi wajah se "assign Kavita ko kiya,
    // dikh Anand ko raha hai" wali shikayat aayi: doer purana hi pada rehta
    // tha. Ab doer yahin se badalta hai. assigned_to hi wo ek jagah hai jise
    // poori app padhti hai (doer_name sirf DB me padhne ki aasani ke liye
    // hai), isliye dono saath badalte hain -- warna DB me naam kuch aur aur
    // task kisi aur ko dikhta.
    if (assignedTo != null && String(assignedTo).trim()) {
      const newDoer = await db.findOne('Users', { id: String(assignedTo).trim() });
      if (!newDoer) return res.status(400).json({ error: 'Doer not found' });
      upd.assigned_to = String(newDoer.id);
      if (tabName === 'Checklist_Tasks') upd.doer_name = newDoer.name || '';
    }
    await db.update(tabName, req.params.id, upd);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Specific /api/tasks/* routes MUST come before the general /:id routes ──

app.get('/api/tasks/user/:userId', requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const tabName = getTabName(type || 'delegation');
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const allTasks = await db.findAll(tabName);
    const tasks = allTasks
      .filter(t => String(t.assigned_to) === String(req.params.userId))
      .map(t => ({
        id: parseInt(t.id),
        type: type || 'delegation',
        description: t.description,
        status: t.status,
        assigned_to: parseInt(t.assigned_to),
        assigned_by: parseInt(t.assigned_by),
        priority: t.priority || 'low',
        approval: (type || 'delegation') === 'delegation' ? (t.approval || 'no') : 'no',
        waiting_approval: (type || 'delegation') === 'delegation' ? (parseInt(t.waiting_approval) || 0) : 0,
        remarks: t.remarks || '',
        due_date: t.due_date || '',
        assigned_on: t.created_at ? t.created_at.split('T')[0].split(' ')[0] : '',
        frequency: t.frequency || '',
        statusChangedAt: t.status_changed_at || '',
        statusChangedByName: t.status_changed_by_name
          || (t.status_changed_by ? (userMap[String(t.status_changed_by)]?.name || '') : ''),
        assignedToName: userMap[String(t.assigned_to)]?.name || '',
        assignedByName: userMap[String(t.assigned_by)]?.name || ''
      }))
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const type = req.body?.type || req.query.type;
    const tabName = getTabName(type || 'delegation');
    const tasks = await db.findWhere(tabName, { assigned_to: req.params.userId });
    for (const t of tasks) {
      if (t.status !== 'completed') await deleteRow(tabName, t.id);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tasks/user/:userId/transfer-today', requireAuth, requireAdmin, async (req, res) => {
  try {
    const todayStr = today();
    const type = req.body?.type || req.query.type;
    const tabName = getTabName(type || 'delegation');
    const tasks = await db.findWhere(tabName, { assigned_to: req.params.userId, status: 'pending' });
    for (const t of tasks) await db.update(tabName, t.id, { due_date: todayStr });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tasks/delete-by-date', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: 'Date required' });
    const tasks = await db.findWhere('Checklist_Tasks', { due_date: date });
    const ids = tasks.map(t => t.id);
    await db.batchDeleteByIds('Checklist_Tasks', ids);
    res.json({ success: true, deleted: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tasks/checklist-year-count', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, year, frequency } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    let tasks = await db.findWhere('Checklist_Tasks', { assigned_to: userId });
    tasks = tasks.filter(t => t.status !== 'completed');
    if (year && year !== 'all') tasks = tasks.filter(t => t.due_date && t.due_date.startsWith(year));
    if (frequency && frequency !== 'all') tasks = tasks.filter(t => t.frequency === frequency);
    res.json({ count: tasks.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tasks/checklist-year-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, frequency } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    let tasks = await db.findWhere('Checklist_Tasks', { assigned_to: String(userId) });
    tasks = tasks.filter(t => t.status !== 'completed');
    if (frequency && frequency !== 'all') tasks = tasks.filter(t => t.frequency === frequency);
    const ids = tasks.map(t => t.id);
    await db.batchDeleteByIds('Checklist_Tasks', ids);
    res.json({ success: true, deleted: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DANGER: checklist tasks permanently delete karta hai (sab users ke).
// scope='completed' (default) → sirf completed/closed wale; pending safe.
// scope='all' → saare checklist tasks.
// Admin-only + confirm token zaroori. Delegation tasks ko kabhi haath nahi lagata.
app.post('/api/tasks/checklist-delete-all', requireAuth, requireAdmin, async (req, res) => {
  try {
    if ((req.body?.confirm || '') !== 'DELETE ALL CHECKLIST') {
      return res.status(400).json({ error: 'Confirmation token missing' });
    }
    const scope = (req.body?.scope === 'all') ? 'all' : 'completed';
    const all = await db.findAll('Checklist_Tasks');
    const target = (scope === 'all')
      ? all
      : all.filter(t => t.status === 'completed' || t.status === 'closed');
    const ids = target.map(t => t.id);
    if (ids.length) await db.batchDeleteByIds('Checklist_Tasks', ids);
    console.log(`  ⚠️  Checklist delete (scope=${scope}) by user ${req.session.userId}: ${ids.length} rows`);
    res.json({ success: true, deleted: ids.length, scope });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Checklist tasks ka "Assigned By" ek user se doosre par shift karta hai.
// Sirf assigned_by badalta hai — doer, date, status, description sab waise hi.
app.post('/api/tasks/checklist-reassign-assigner', requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = String(req.body?.fromUserId || '');
    const to = String(req.body?.toUserId || '');
    if (!from || !to) return res.status(400).json({ error: 'fromUserId aur toUserId dono chahiye' });
    const all = await db.findAll('Checklist_Tasks');
    const target = all.filter(t => String(t.assigned_by) === from);
    for (const t of target) await db.update('Checklist_Tasks', t.id, { assigned_by: to });
    console.log(`  Checklist assigned_by ${from} -> ${to}: ${target.length} tasks updated`);
    res.json({ success: true, updated: target.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── "Likha Kavita, dikh Anand ko" wale task theek karo ──
// Checklist row me doer DO jagah likha hota hai: assigned_to (ID -- app SIRF
// ise padhti hai) aur doer_name (naam -- sirf phpMyAdmin me dekhne ke liye).
// phpMyAdmin me doer_name badal dene se task doosre bande ko NAHI jaata,
// kyunki app use padhti hi nahi -- assigned_to purana hi pada rehta hai.
// Harsh ne 15 Sep 2026 ko yahi pakda: "assign doer hai Kavita aur show ho
// raha hai Anand ko."
//
// Ye endpoint un rows ka assigned_to us bande par le jaata hai JO NAAM ROW
// ME LIKHA HAI -- yaani jo likha hai wahi dikhne lagega.
//
// DEFAULT DRY-RUN hai: bina ?apply=1 ke kuch nahi badalta, sirf batata hai
// kya-kya badlega. Completed task ko haath nahi lagate (purana record aur
// MIS hil jaata) -- sirf khule task, jab tak ?withDone=1 na do.
app.post('/api/tasks/fix-doer-mismatch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const apply    = String(req.query.apply || req.body?.apply || '') === '1';
    const withDone = String(req.query.withDone || req.body?.withDone || '') === '1';
    const [chl, users] = await Promise.all([
      db.findAll('Checklist_Tasks'), db.findAll('Users')
    ]);
    const norm = s => String(s || '').trim().toLowerCase();
    const byId = {};
    users.forEach(u => { byId[String(u.id)] = u; });
    // naam -> saare users jinka wahi naam hai (ek naam ke do bande ho sakte hain)
    const byName = {};
    users.forEach(u => { (byName[norm(u.name)] = byName[norm(u.name)] || []).push(u); });

    // ?labels=1 -> task KISI KO NAHI HILATE. Sirf doer_name ko assigned_to
    // wale bande ke naam par taaza kar dete hain. Ye un rows ke liye hai
    // jinka banda wahi hai par naam badal diya gaya tha (jaise "Naresh" ->
    // "NARESH VERMA") -- wahan task hilana bilkul galat hota.
    const labelsOnly = String(req.query.labels || req.body?.labels || '') === '1';

    const badlenge = [], naamBadla = [], kaiUser = [], chhode = [], labelTheek = [];
    for (const t of chl) {
      const likha = String(t.doer_name || '').trim();
      if (!likha) continue;
      const abhiWala = byId[String(t.assigned_to)];
      if (abhiWala && norm(abhiWala.name) === norm(likha)) continue;   // pehle se theek
      if (!withDone && t.status === 'completed') { chhode.push(t.id); continue; }
      const match = byName[norm(likha)] || [];
      if (match.length === 0) {
        // Is naam ka koi user hai hi nahi -> banda wahi hai, naam badla tha.
        // Task HILANA NAHI -- sirf purana label taaza karna hai.
        if (abhiWala) labelTheek.push({ id: t.id, purana_label: likha, naya_label: abhiWala.name });
        else naamBadla.push({ id: t.id, naam: likha, wajah: 'assigned_to bhi Users me nahi -- ?orphans=1 dekho' });
        continue;
      }
      if (match.length > 1) { kaiUser.push({ id: t.id, naam: likha, kitne_user: match.length }); continue; }
      badlenge.push({
        id: t.id,
        naam: likha,
        purana: abhiWala ? abhiWala.name : `(id ${t.assigned_to} -- Users me hai hi nahi)`,
        naya_id: String(match[0].id)
      });
    }

    if (apply && labelsOnly) {
      for (const l of labelTheek) {
        await db.update('Checklist_Tasks', l.id, { doer_name: l.naya_label });
      }
      console.log(`  doer-label refresh: ${labelTheek.length} checklist row ka purana naam taaza kiya (task kisi ka nahi hila)`);
    } else if (apply) {
      for (const b of badlenge) {
        await db.update('Checklist_Tasks', b.id, { assigned_to: b.naya_id, doer_name: b.naam });
      }
      console.log(`  doer-mismatch fix: ${badlenge.length} checklist task sahi doer par bheje`);
    }

    res.json({
      chala: apply
        ? (labelsOnly ? 'HAAN -- sirf purane naam taaza kiye, task kisi ka nahi hila' : 'HAAN -- task sahi doer par bhej diye')
        : 'NAHI (dry-run) -- kuch nahi badla. Task hilane ke liye ?apply=1, sirf naam taaza karne ke liye ?apply=1&labels=1',
      TASK_HILENGE: badlenge.length,
      task_hilne_ke_namune: badlenge.slice(0, 20),
      SIRF_NAAM_PURANA_HAI_task_sahi_jagah: labelTheek.length,
      naam_taaza_karne_ke_namune: labelTheek.slice(0, 10),
      ek_naam_ke_kai_user_chhode: kaiUser.slice(0, 20),
      doer_hi_nahi_mila: naamBadla.slice(0, 10),
      completed_chhode: withDone ? 0 : chhode.length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// ONE-TIME MIGRATIONS — startup par chalti hain, App_State marker se sirf
// EK BAAR. Dobara deploy/restart hone par apne aap skip ho jaati hain.
// ══════════════════════════════════════════════════════
// Purane checklist rows me doer_name khali hai — ek baar bhar dete hain.
// MySQL par ek hi UPDATE...JOIN se (6000+ rows bhi pal bhar me), warna
// row-by-row. Marker se sirf ek baar chalta hai.
// ── KHALI DATE WALE CHECKLIST TASK ── EK-EK DIN KARKE DATE DO ──
// Kuch checklist rows ki due_date "NaN-NaN-NaN" ban gayi thi (CSV import me
// start date parse nahi hui thi -- wo bug ab band hai), kuch bilkul khali
// hain. Screen par dono "-" dikhti hain.
// Harsh (7 Sep 2026): "daily wale jo task hain, jab se done nahi kiye hain
// wo date assign kar dena -- kal hi ki mat daal dena."
// Isliye SAB EK HI DIN par nahi jaate. Har batch ko uske upload wale din se
// shuru karke, uski apni frequency ke hisaab se ek-ek karke dates milti hain
// (daily me Sunday chhoot jaata hai, bilkul jaise app khud banata hai).
// Ek batch = ek hi doer + ek hi kaam + ek hi frequency + ek hi upload waqt;
// rows ka kram id se (jis kram me bani thin).
// Sirf Checklist_Tasks -- delegation ko haath nahi lagate.

// "2026-07-14 05:12:33" -> {y,mo,d}. Na samjhe to null.
function ymdFromStamp(stamp) {
  const m = String(stamp || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3] };
}

// Ek batch ke liye utni dates jitni rows -- frequency ke hisaab se aage.
function seriesFrom(startYmd, freq, count) {
  const out = [];
  const d = new Date(Date.UTC(startYmd.y, startYmd.mo - 1, startYmd.d));
  let safety = count * 14 + 40;
  while (out.length < count && safety-- > 0) {
    if (freq === 'daily' && d.getUTCDay() === 0) {   // Sunday chhodo
      d.setUTCDate(d.getUTCDate() + 1);
      continue;
    }
    out.push(d.toISOString().split('T')[0]);
    if (freq === 'daily')                 d.setUTCDate(d.getUTCDate() + 1);
    else if (freq === 'weekly')           d.setUTCDate(d.getUTCDate() + 7);
    else if (freq === 'alternative_week') d.setUTCDate(d.getUTCDate() + 14);
    else if (freq === 'monthly')          d.setUTCMonth(d.getUTCMonth() + 1);
    else if (freq === 'quarterly')        d.setUTCMonth(d.getUTCMonth() + 3);
    else if (freq === 'yearly')           d.setUTCFullYear(d.getUTCFullYear() + 1);
    else                                  d.setUTCDate(d.getUTCDate() + 1);   // pata nahi to roz
  }
  return out;
}

// ── ULTI LIKHI DATE SEEDHI KARO (DD-MM-YYYY -> YYYY-MM-DD) ──────
// 7 Sep 2026 ki ginti: 4999 checklist rows me se 84 ki due_date
// "08-09-2026" jaisi thi (HR ki 82, Reet ki 2), baaki 4915 theek.
// Ye sirf dikhne ki baat nahi -- poora app date ko YYYY-MM-DD maan kar
// SEEDHE compare karta hai (sort, overdue, reminder ka cutoff). "08-09-2026"
// me pehla akshar '0' hai, isliye wo har cutoff se chhoti nikalti hai aur
// row hamesha "due" lagti hai. Isliye DB me hi seedhi kar dete hain.
//
// DD-MM-YYYY hai ya MM-DD-YYYY? Rows ka apna kram batata hai: ek monthly
// batch me 08-09-2026, 08-10-2026, 08-11-2026, 08-12-2026 — mahina badal
// raha hai, din nahi. Yaani DD pehle.
function flipToIso(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (!m) return '';
  const da = +m[1], mo = +m[2], y = +m[3];
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return '';
  const d = new Date(Date.UTC(y, mo - 1, da));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return '';
  return y + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0');
}

// ── Ulti likhi due_date: dhoondho, ginti karo, seedhi karo ──────────
// Pehle ye ek-baar-chalne wale marker se bandha tha (v2). Us tarah kuch rows
// chhoot gayi thin: marker "ho gaya" bolta raha aur Nishant ki 7 monthly rows
// July se ulti padi rahin. Ab har start par dekh lete hain -- kuch ulta na
// mile to ek bhi write nahi hota, isliye ye sasta hai aur chhoot nahi sakta.

// Ulti date do tarah ka nuksaan karti hai. App date ko seedha string ki tarah
// tolta hai, isliye:
//   "21-" se "31-" tak  ->  har cutoff se BADI  ->  task KABHI nahi dikhta
//   "01-" se "20-" tak  ->  har cutoff se CHHOTI ->  task waqt se PEHLE dikhta
// Nishant ki saari rows 28 aur 30 taarikh ki thin, isliye ek bhi nahi dikhi.
function ultiKaHaal(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (!m) return null;
  return (+m[1] >= 21) ? 'chhipi' : 'jaldi';
}

// Dono table me ulti date dhoondho. Ye sirf padhta hai, kuch badalta nahi.
async function scanUltiDates() {
  const d = await getDB();
  const [chl, del, users] = await Promise.all([
    d.findAll('Checklist_Tasks').catch(() => []),
    d.findAll('Delegation_Tasks').catch(() => []),
    d.findAll('Users').catch(() => [])
  ]);
  const naam = {};
  for (const u of users) naam[String(u.id)] = u.name || '';
  const out = [];
  const dekho = (rows, tab) => rows.forEach(t => {
    const v = String(t.due_date == null ? '' : t.due_date).trim();
    if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) return;
    const iso = flipToIso(v);
    if (!iso) return;                        // samajh na aaye to haath mat lagao
    out.push({
      tab, id: t.id, iso,
      doer: (tab === 'Checklist_Tasks' && t.doer_name)
        ? t.doer_name : (naam[String(t.assigned_to)] || ('id ' + t.assigned_to)),
      khula: (t.status === 'pending' || t.status === 'revised'),
      haal: ultiKaHaal(v),
      // pehla khaana 12 se bada = wo mahina ho hi nahi sakta = pakka DIN hai
      dinPakka: (parseInt(v, 10) > 12)
    });
  });
  dekho(chl, 'Checklist_Tasks');
  dekho(del, 'Delegation_Tasks');
  return out;
}

// Khule task doer ke hisaab se: kitne chhipe the, kitne jaldi dikh rahe the
function ultiGinti(list) {
  const g = {};
  list.filter(x => x.khula).forEach(x => {
    const k = x.doer + ' \u2014 ' + (x.tab === 'Checklist_Tasks' ? 'Checklist' : 'Delegation');
    const r = g[k] = g[k] || { chhipi: 0, jaldi: 0 };
    if (x.haal === 'chhipi') r.chhipi++; else r.jaldi++;
  });
  return g;
}

async function straightenTaskDates() {
  try {
    const d = await getDB();
    const ulti = await scanUltiDates();
    if (!ulti.length) return;                     // sab seedhi -- kuch mat chhedo

    // Pehli baar jo mila wo likh kar rakh lo. Seedhi karne ke BAAD ye sawaal
    // kahin se nahi poochha ja sakta ki kiske kitne task chhipe hue the.
    try {
      await ensureAppStateTab(d);
      const pehle = await d.findWhere('App_State', { key_name: 'checklist_ulti_date_report' });
      if (!pehle || !pehle.length) {
        const g = ultiGinti(ulti);
        const lines = Object.keys(g).sort().map(k =>
          k + ': ' + g[k].chhipi + ' chhipi + ' + g[k].jaldi + ' jaldi');
        const pakka = ulti.filter(x => x.dinPakka).length;
        await d.insert('App_State', {
          key_name: 'checklist_ulti_date_report',
          value: 'kul ' + ulti.length + ' ulti date, ' + ulti.filter(x => x.khula).length +
                 ' khule task | DD-first saboot: ' + pakka + ' rows me din 12 se bada | ' +
                 (lines.join(' | ') || 'koi khula task nahi'),
          updated_at: new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0]
        });
      }
    } catch { /* report na likh paye to bhi fix to karna hi hai */ }

    // Ab Delegation ki bhi -- Harsh, 8 Oct. Pehle ise chhoda tha, par uski
    // ulti date "overdue" ki ginti galat karti hai, aur overdue seedha SCORE
    // ke formula me jaata hai: -(pending/total)*100 -(overdue/total)*50 ...
    // Yaani logon ke number galat ban rahe the. Ek jagah data seedha karne se
    // badge, ginti, sorting aur report -- sab ek saath theek ho jaate hain.
    //
    // Ulta padhne ka khatra nahi: flipToIso dusre khaane ko mahina maanta hai
    // aur 12 se bada mahina maante hi row chhod deta hai. Aur ginti me dikhta
    // hai ki bahut si rows ka pehla khaana 12 se bada hai -- wo mahina ho hi
    // nahi sakta, to pehle DIN hi likha hai.
    let fixed = 0, chhodi = 0;
    for (const x of ulti) {
      try { await d.update(x.tab, x.id, { due_date: x.iso }); fixed++; }
      catch { chhodi++; }                     // agli start par phir koshish hogi
    }
    console.log('  \u2705 ulti date seedhi ki: ' + fixed + '/' + ulti.length +
                (chhodi ? ' (' + chhodi + ' reh gayi, agli baar phir)' : ''));
  } catch (e) {
    console.error('  straightenTaskDates error (agli baar retry hogi):', e.message);
  }
}

async function fixChecklistDateFormat() {
  // v2: 12 Sep ko 26 nayi ulti dates mil gayi thin (source ab band ho chuka),
  // isliye ek baar aur chalana hai
  const MARKER = 'checklist_date_format_fix_v2';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const all = await d.findAll('Checklist_Tasks').catch(() => []);
    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];

    let fixed = 0, chhodi = 0;
    for (const t of all) {
      const v = String(t.due_date == null ? '' : t.due_date).trim();
      if (!v || /^\d{4}-\d{2}-\d{2}$/.test(v)) continue;   // pehle se theek
      const iso = flipToIso(v);
      if (!iso) { chhodi++; continue; }                      // samajh na aaye to haath mat lagao
      try { await d.update('Checklist_Tasks', t.id, { due_date: iso }); fixed++; }
      catch { chhodi++; }
    }

    const msg = `${fixed} ulti date seedhi ki` + (chhodi ? `, ${chhodi} samajh nahi aayi (chhod di)` : '');
    await d.insert('App_State', { key_name: MARKER, value: msg, updated_at: nowStr });
    console.log('  \u2705 checklist date format: ' + msg);
  } catch (e) {
    console.error('  fixChecklistDateFormat error (agli baar retry hogi):', e.message);
  }
}

async function repairNaNChecklistDates() {
  const MARKER = 'checklist_blank_date_fix_v3';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const all = await d.findAll('Checklist_Tasks').catch(() => []);
    // "Blank dikhne wali" = khali bhi, aur NaN wali bhi
    const bad = all.filter(t => {
      const v = String(t.due_date == null ? '' : t.due_date).trim();
      return !v || v.includes('NaN');
    });

    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];
    const todayIst = nowStr.split(' ')[0];

    if (!bad.length) {
      await d.insert('App_State', { key_name: MARKER, value: 'koi khali-date row mili hi nahi', updated_at: nowStr });
      console.log('  checklist blank-date: koi row nahi mili');
      return;
    }

    // Batch banao -- ek hi doer + kaam + frequency + upload waqt
    const batches = {};
    bad.forEach(t => {
      const key = [t.assigned_to, t.description, t.frequency, t.created_at].join('|~|');
      (batches[key] = batches[key] || []).push(t);
    });

    let fixed = 0, failed = 0;
    for (const key of Object.keys(batches)) {
      const rows = batches[key].sort((a, b) => (parseInt(a.id) || 0) - (parseInt(b.id) || 0));
      // Shuruaat: jab upload hua tha. Wo bhi na mile to aaj se.
      const start = ymdFromStamp(rows[0].created_at) || ymdFromStamp(todayIst);
      const freq = String(rows[0].frequency || '').toLowerCase().trim();
      const dates = seriesFrom(start, freq, rows.length);
      for (let k = 0; k < rows.length; k++) {
        if (!dates[k]) { failed++; continue; }
        try { await d.update('Checklist_Tasks', rows[k].id, { due_date: dates[k] }); fixed++; }
        catch { failed++; }
      }
    }

    const msg = `${fixed} row ko ek-ek din ki date di` + (failed ? `, ${failed} nahi ho payi` : '') +
                ` (${Object.keys(batches).length} batch)`;
    await d.insert('App_State', { key_name: MARKER, value: msg, updated_at: nowStr });
    console.log('  \u2705 checklist blank-date: ' + msg);
  } catch (e) {
    console.error('  repairNaNChecklistDates error (agli baar retry hogi):', e.message);
  }
}

async function backfillChecklistDoerName() {
  const MARKER = 'checklist_doer_name_backfill_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    let filled = 0;
    if (d.pool) {
      // MySQL — ek hi query, sabse tez
      const [r] = await d.pool.query(
        'UPDATE `Checklist_Tasks` c JOIN `Users` u ON u.id = c.assigned_to ' +
        "SET c.doer_name = u.name WHERE c.doer_name = '' OR c.doer_name IS NULL"
      );
      filled = (r && r.affectedRows) || 0;
    } else {
      // Sheets — row by row
      const [tasks, users] = await Promise.all([d.findAll('Checklist_Tasks'), d.findAll('Users')]);
      const byId = {};
      users.forEach(u => { byId[String(u.id)] = u.name || ''; });
      for (const t of tasks) {
        if (t.doer_name) continue;
        const nm = byId[String(t.assigned_to)] || '';
        if (!nm) continue;
        await d.update('Checklist_Tasks', t.id, { doer_name: nm }).catch(() => {});
        filled++;
      }
    }

    await d.insert('App_State', {
      key_name: MARKER, value: `filled ${filled}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ Checklist doer_name bhara: ${filled} row`);
  } catch (e) {
    console.error('  backfillChecklistDoerName error (agli baar retry hogi):', e.message);
  }
}

// Ek bande ka naam badla -> uske checklist task ka doer_name bhi wahi kar do.
// SIRF label badalta hai. assigned_to ko HAATH NAHI LAGATA, isliye kisi ka
// task kisi aur ke paas nahi jaata -- ye pakka hai.
async function syncDoerName(userId, naya) {
  const d = await getDB();
  if (d.pool) {
    const [r] = await d.pool.query(
      'UPDATE `Checklist_Tasks` SET `doer_name` = ? WHERE `assigned_to` = ? AND `doer_name` <> ?',
      [String(naya), String(userId), String(naya)]
    );
    d._invalidate && d._invalidate('Checklist_Tasks');
    return (r && r.affectedRows) || 0;
  }
  const tasks = await d.findAll('Checklist_Tasks');
  let n = 0;
  for (const t of tasks) {
    if (String(t.assigned_to) !== String(userId)) continue;
    if (String(t.doer_name || '') === String(naya)) continue;
    await d.update('Checklist_Tasks', t.id, { doer_name: naya }).catch(() => {});
    n++;
  }
  return n;
}

// ── PURANE LABEL EK BAAR THEEK KARO ──
// Jin rows ka doer_name us bande ke ABHI wale naam se nahi milta, unka label
// taaza kar do. 15 Sep 2026 ko 182 aisi rows thin (165 sirf "Naresh" ->
// "NARESH VERMA" ke rename ki wajah se).
//
// DHYAN: ye SIRF doer_name likhta hai. assigned_to ko chhuta tak nahi --
// yaani kisi ka task kisi aur ke paas nahi jaata, na koi task pending/done
// hota hai. Label jhooth bolna band kar deta hai, bas.
//
// Jo task SACH ME galat aadmi ke paas hai (jaise "Ravi Kant" likha hai par
// ek alag zinda user "Ravi Kant" bhi maujood hai) -- unhe ye NAHI chhedta.
// Wo faisla aadmi ka hai, isliye wo /api/tasks/fix-doer-mismatch se alag se
// hota hai, haath se.
async function resyncChecklistDoerLabels() {
  const MARKER = 'checklist_doer_name_resync_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const [tasks, users] = await Promise.all([d.findAll('Checklist_Tasks'), d.findAll('Users')]);
    const norm = s => String(s || '').trim().toLowerCase();
    const byId = {}, byName = {};
    users.forEach(u => { byId[String(u.id)] = String(u.name || ''); });
    users.forEach(u => { (byName[norm(u.name)] = byName[norm(u.name)] || []).push(u); });

    let taaza = 0, chhode = 0;
    for (const t of tasks) {
      const likha = String(t.doer_name || '').trim();
      if (!likha) continue;
      const abhiKaNaam = byId[String(t.assigned_to)];
      if (abhiKaNaam === undefined) continue;             // orphan -- alag masla
      if (norm(likha) === norm(abhiKaNaam)) continue;     // pehle se theek
      // Likha hua naam kisi ZINDA user ka hai -> ye rename nahi, asli gadbad
      // ho sakti hai. Aadmi khud faisla kare, hum label badal kar saboot nahi
      // mitayenge.
      if ((byName[norm(likha)] || []).length > 0) { chhode++; continue; }
      await d.update('Checklist_Tasks', t.id, { doer_name: abhiKaNaam }).catch(() => {});
      taaza++;
    }

    const msg = `${taaza} purane label taaza kiye` + (chhode ? `, ${chhode} chhode (wo rename nahi -- haath se dekhne hain)` : '');
    await d.insert('App_State', {
      key_name: MARKER, value: msg,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ checklist doer label resync: ${msg}`);
  } catch (e) {
    console.error('  resyncChecklistDoerLabels error (agli baar retry hogi):', e.message);
  }
}

// ── Ashok ke 17 task par "Ravi Kant" ka galat label ──
// 15 Sep 2026. Ye aakhri bacha hua mismatch tha. Faisla ginti se nikala,
// andaze se nahi:
//   Ravi Kant (id 9, headdesigner@raabtajewels.com) -- checklist task: 0
//   Ashok Sn  (id 5, ashok@raabtajewels.com)        -- checklist task: 553
//   Vivadit kaam: "Align Karigars & beading staff for Production" x17,
//     2026-07-21 ko bane, tab se assigned_to = 5 (Ashok) hi hai.
//   Ashok ke baaki kaam: "stock of pearl chain used for kaleeras",
//     "stocks of semi precious stones & beads" -- yaani beads/production ka
//     kaam Ashok hi dekhta hai. Ravi Kant Head Designer hai aur uske paas
//     ek bhi checklist task nahi hai.
// Nateeja: task SAHI bande ke paas hai, sirf doer_name galat likha reh gaya.
// Isliye task HILATE NAHI -- sirf label theek karte hain.
//
// Ye jaan-boojh kar tang rakha hai (sirf yahi naam + yahi id), taaki koi
// aur row galti se na chhoo jaye. Galat nikle to Edit Task me Doer badal
// kar kabhi bhi palta ja sakta hai.
// ── Mumbai SM ke task ka label wapas "Mumbai SM" (14 Oct) ────────────
// phpMyAdmin me galti se ye query chal gayi thi:
//   UPDATE Checklist_Tasks SET doer_name = 'Akshatha Pillai'
//   WHERE doer_name LIKE '%Mumbai SM%'
// Isse 217 rows ka NAAM badla, par task Mumbai SM (assigned_to) ke paas hi
// rahe -- yaani "likha Akshatha, dikh Mumbai SM ko raha" wali gadbad bani.
// Harsh ne kaha: label wapas kar do. Yahi karte hain, aur kuch nahi.
//
// Kitna sakht dhaancha:
//   * sirf Checklist_Tasks ka doer_name likhte hain; assigned_to, status,
//     date, kuch nahi chhute
//   * sirf wo rows jinka assigned_to MUMBAI SM ka id ho AUR label
//     "Akshatha Pillai" ho -- Akshatha ki apni rows (alag id) nahi chhutin
//   * "Mumbai SM" naam ke ek se zyada user hon, ya ek bhi na ho, to kuch nahi
//     karte aur marker bhi nahi likhte -- agli baar phir dekhte hain
//   * koi row update na ho paaye to marker nahi likhte, taaki agli start par
//     baaki bachi hui rows bhi ho jaayen
//   * marker ke baad kabhi dobara nahi chalta, isliye baad me koi jaanboojh kar
//     label badle to ye use wapas nahi palatta
// ── Mumbai SM ke saare checklist task -> Akshatha Pillai, phir user delete ──
// Harsh, 15 Oct: "Mumbai SM ke jitne bhi checklist ke task hain wo sab
// Akshatha Pillai ko transfer kar do, aur Mumbai SM user delete kar do."
//
// Kyun app ke Transfer button se nahi: wo ek-ek task par chalta hai aur
// WhatsApp alert bhejta hai -- 217 task par Akshatha ko 217 message jaate.
// Yahan seedha assigned_to + doer_name badalte hain, koi message nahi.
//
// Kram aur rokne ki jagahein (beech me kuch bhi atke to user NAHI hatta):
//   1. dono user email se dhoondho, DONO ek-ek hi milne chahiye
//   2. pehle backup (task ki id list + user ki row) App_State me
//   3. har task: sirf assigned_to aur doer_name badlo (status/date/assigned_by
//      kuch nahi chhute) -- completed bhi, kyunki Harsh ne "sab" kaha
//   4. dobara padh kar pakka karo ki Mumbai SM ke paas ek bhi task nahi bacha
//   5. Mumbai SM ke khule DELEGATION task hon to user nahi hatate -- wo task
//      bina doer ke reh jaate (is baat par Harsh ne pehle bhi warning maangi thi)
//   6. tabhi user delete, aur tabhi marker
// Marker ke baad kabhi dobara nahi chalta.
async function transferMumbaiSmToAkshatha() {
  const MARKER = 'mumbai_sm_to_akshatha_v1';
  const BACKUP = 'mumbai_sm_to_akshatha_backup_v1';
  const MUMBAI_EMAIL = 'rbrmumbai@raabtajewels.com';
  const AKSHATHA_EMAIL = 'pillaiakshatha30@gmail.com';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const em = x => String(x || '').trim().toLowerCase();
    const users = await d.findAll('Users');
    const mum = users.filter(u => em(u.email) === MUMBAI_EMAIL);
    const aks = users.filter(u => em(u.email) === AKSHATHA_EMAIL);
    if (mum.length !== 1 || aks.length !== 1) {
      console.log('  Mumbai->Akshatha: Mumbai SM ' + mum.length + ' user, Akshatha ' + aks.length +
                  ' user mile (dono ek-ek chahiye) -- skip');
      return;
    }
    const M = mum[0], A = aks[0];
    if (String(M.id) === String(A.id)) { console.log('  Mumbai->Akshatha: dono ek hi user -- skip'); return; }

    const chl = await d.findAll('Checklist_Tasks');
    const target = chl.filter(t => String(t.assigned_to) === String(M.id));

    // ── 2) Backup, kuch bhi badalne se PEHLE. Na bane to kuch nahi karte. ──
    // Password aur photo nahi rakhte -- wo bhaari/sensitive hai aur ek hi DB me
    // dusri jagah kyon dohrana. Wapas laana ho to ye row + naya password.
    const hai = await d.findWhere('App_State', { key_name: BACKUP });
    if (!hai || !hai.length) {
      const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];
      const userCopy = Object.assign({}, M); delete userCopy.password; delete userCopy.profile_image;
      try {
        await d.insert('App_State', {
          key_name: BACKUP,
          value: JSON.stringify({
            at: nowStr, from: { id: M.id, name: M.name }, to: { id: A.id, name: A.name },
            checklist_ids: target.map(t => t.id),     // wapas karna ho: assigned_to = from.id inhi id par
            deleted_user: userCopy
          }),
          updated_at: nowStr
        });
      } catch (e) {
        console.error('  Mumbai->Akshatha: backup nahi bana, isliye kuch NAHI badla:', e.message);
        return;
      }
    }

    // ── 3) Transfer ──
    let ho = 0, fail = 0;
    for (const t of target) {
      try { await d.update('Checklist_Tasks', t.id, { assigned_to: String(A.id), doer_name: A.name }); ho++; }
      catch { fail++; }
    }
    console.log('  Mumbai->Akshatha: ' + ho + '/' + target.length + ' checklist task transfer' +
                (fail ? ', ' + fail + ' reh gaye' : ''));

    // ── 4) Pakka karo ki Mumbai SM ke paas kuch nahi bacha ──
    const baaki = (await d.findAll('Checklist_Tasks')).filter(t => String(t.assigned_to) === String(M.id)).length;
    if (fail || baaki) {
      console.log('  Mumbai->Akshatha: ' + baaki + ' task abhi bhi Mumbai SM ke paas -- user NAHI hataya, agli start par phir');
      return;
    }

    // ── 5) Khule delegation task ho to user mat hatao ──
    const del = await d.findAll('Delegation_Tasks').catch(() => []);
    const openDel = del.filter(t => String(t.assigned_to) === String(M.id) &&
                                    (t.status === 'pending' || t.status === 'revised')).length;
    if (openDel) {
      console.log('  Mumbai->Akshatha: Mumbai SM ke ' + openDel + ' khule delegation task hain -- user NAHI hataya');
      return;
    }

    // ── 6) User delete + marker ──
    await d.delete('Users', M.id);
    const nowStr2 = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];
    await d.insert('App_State', {
      key_name: MARKER,
      value: ho + ' checklist task Mumbai SM (id ' + M.id + ') -> ' + A.name + ' (id ' + A.id + '); Mumbai SM user delete',
      updated_at: nowStr2
    });
    console.log('  \u2705 Mumbai->Akshatha: ' + ho + ' task transfer, Mumbai SM user delete');
  } catch (e) {
    console.error('  transferMumbaiSmToAkshatha error (agli baar retry hogi):', e.message);
  }
}

async function restoreMumbaiSmLabels() {
  const MARKER = 'checklist_mumbai_sm_label_restore_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const norm = x => String(x || '').trim().toLowerCase();
    const users = await d.findAll('Users');
    const mumbai = users.filter(u => norm(u.name) === 'mumbai sm');
    if (mumbai.length !== 1) {
      console.log('  Mumbai SM label restore: "Mumbai SM" naam ke ' + mumbai.length + ' user mile -- skip');
      return;
    }
    const m = mumbai[0];

    const chl = await d.findAll('Checklist_Tasks');
    const target = chl.filter(t =>
      String(t.assigned_to) === String(m.id) &&
      norm(t.doer_name) === 'akshatha pillai');

    let ho = 0, fail = 0;
    for (const t of target) {
      try { await d.update('Checklist_Tasks', t.id, { doer_name: m.name }); ho++; }
      catch { fail++; }
    }
    console.log('  Mumbai SM label restore: ' + ho + '/' + target.length + ' row ho gayi' +
                (fail ? ', ' + fail + ' reh gayi (agli start par phir)' : ''));
    if (fail) return;                        // adhoora kaam -- marker mat likho

    await d.insert('App_State', {
      key_name: MARKER,
      value: ho + ' row ka label "Akshatha Pillai" -> "' + m.name + '" (id ' + m.id + '); task kisi ka nahi hila',
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
  } catch (e) {
    console.error('  restoreMumbaiSmLabels error (agli baar retry hogi):', e.message);
  }
}

async function fixRaviKantLabelOnAshok() {
  const MARKER = 'checklist_ravikant_label_fix_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const users = await d.findAll('Users');
    const ashok = users.find(u => String(u.email || '').trim().toLowerCase() === 'ashok@raabtajewels.com');
    // Banda hi na mile to kuch mat karo -- marker bhi mat likho, agli baar
    // dobara koshish ho jayegi.
    if (!ashok) { console.log('  RaviKant label fix: ashok@raabtajewels.com nahi mila -- skip'); return; }

    const chl = await d.findAll('Checklist_Tasks');
    const target = chl.filter(t =>
      String(t.assigned_to) === String(ashok.id) &&
      String(t.doer_name || '').trim().toLowerCase() === 'ravi kant');

    let n = 0;
    for (const t of target) {
      await d.update('Checklist_Tasks', t.id, { doer_name: ashok.name }).catch(() => {});
      n++;
    }
    const msg = `${n} row ka label "Ravi Kant" -> "${ashok.name}" (task kisi ka nahi hila)`;
    await d.insert('App_State', {
      key_name: MARKER, value: msg,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ RaviKant label fix: ${msg}`);
  } catch (e) {
    console.error('  fixRaviKantLabelOnAshok error (agli baar retry hogi):', e.message);
  }
}

// ── Harsh ki 2026 holiday list ek baar daal do ──
// 16 Sep 2026: pehle chhuttiyan localStorage me thin, isliye "Holiday List"
// sabko khali dikhti thi. Ab DB me hain, aur ye list ek baar seed ho jaati
// hai taaki haath se 8 baar type na karni pade.
//
// DHYAN: yahan JAAN-BOOJH KAR koi task delete NAHI hota. Modal se chhutti
// add karne par us din ke checklist task hat jaate hain, par usme purani
// tareekh daali hi nahi ja sakti thi. Is list me 4 tareekhen guzar chuki
// hain (26 Jan, 4 Mar, 15 Aug, 28 Aug) -- un din ka jo kaam ho chuka hai
// uska record mita dena bilkul galat hota. Isliye seed sirf chhutti likhta
// hai, task ko haath nahi lagata.
const HOLIDAYS_2026 = [
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-03-04', name: 'Holi' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-08-28', name: 'Raksha Bandhan' },
  { date: '2026-10-02', name: 'Mahatma Gandhi Jayanti' },
  { date: '2026-10-11', name: 'Navratri' },
  { date: '2026-11-08', name: 'Diwali (Deepavali)' },
  { date: '2026-11-09', name: 'Govardhan Puja' },
  { date: '2026-11-11', name: 'Bhai Dooj' }
];

async function seedHolidays2026() {
  const MARKER = 'holidays_2026_seed_v2';   // v2: Navratri judi (10 Oct)
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const pehle = await d.findAll('Holidays').catch(() => []);
    const hai = new Set(pehle.map(h => String(h.date || '').trim()));
    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];

    let daale = 0;
    for (const h of HOLIDAYS_2026) {
      if (hai.has(h.date)) continue;          // pehle se hai to dobara mat daalo
      await d.insert('Holidays', { date: h.date, name: h.name, created_at: nowStr }).catch(() => {});
      daale++;
    }
    await d.insert('App_State', { key_name: MARKER, value: `${daale} chhutti daali`, updated_at: nowStr });
    console.log(`  ✅ Holidays 2026 seed: ${daale} chhutti daali (koi task delete nahi hua)`);
  } catch (e) {
    console.error('  seedHolidays2026 error (agli baar retry hogi):', e.message);
  }
}

async function runOneTimeMigrations() {
  // Checklist tasks ka "Assigned By: Harsh" -> "Rahul Sir"
  const MARKER = 'migration_checklist_harsh_to_rahul_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const already = await d.findWhere('App_State', { key_name: MARKER });
    if (already && already.length) return;   // pehle ho chuki

    const users = await d.findAll('Users');
    const byName = n => users.find(u => (u.name || '').trim().toLowerCase() === n);
    const from = byName('harsh'), to = byName('rahul sir');
    if (!from || !to) {
      console.log('  Migration skipped — Harsh/Rahul Sir user nahi mila');
      return;
    }
    const all = await d.findAll('Checklist_Tasks');
    const target = all.filter(t => String(t.assigned_by) === String(from.id));
    for (const t of target) await d.update('Checklist_Tasks', t.id, { assigned_by: String(to.id) });

    await d.insert('App_State', {
      key_name: MARKER, value: `updated ${target.length}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ Migration: ${target.length} checklist task(s) ka Assigned By "${from.name}" -> "${to.name}"`);
  } catch (e) {
    console.error('  Migration error (agli baar retry hogi):', e.message);
  }
}


// ══════════════════════════════════════════════════════
// BACKFILL — Outbox aane se PEHLE jo assign-alert gum ho gaye (18-19 Aug),
// unke liye ek baar ka sudhaar. Har bande ko EK hi message jaata hai jisme
// uske pichhle 2 din ke saare naye task ginaye hote hain (N alag message
// nahi — warna jinko pehle mil chuka tha unko spam lagta).
// App_State marker se sirf EK BAAR chalta hai.
// ══════════════════════════════════════════════════════
// Ek baar ka sudhaar: jo message purane (5 saath-saath wale) tareeke se
// timeout ho gaye the, unki ginti zero karke naya mauka do — ab ek-ek karke
// aur 150s intezaar ke saath jayenge. Harsh ka niyam: message chhootna nahi
// chahiye, bhale ek-aadh ko dobara mil jaye.
async function resetTimedOutOutbox() {
  const MARKER = 'wa_outbox_reset_after_serial_fix_v1';
  try {
    if (!waAutoAllowed()) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const already = await d.findWhere('App_State', { key_name: MARKER });
    if (already && already.length) return;

    const rows = await d.findAll('WA_Outbox');
    const stuck = rows.filter(r => r.status !== 'sent');
    for (const r of stuck) {
      await d.update('WA_Outbox', r.id, { status: 'pending', attempts: '0', last_error: '' }).catch(() => {});
    }
    await d.insert('App_State', {
      key_name: MARKER, value: `reset ${stuck.length}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ Outbox reset: ${stuck.length} message ko naya mauka`);
    drainWhatsAppOutbox().catch(() => {});
  } catch (e) {
    console.error('  Outbox reset error (agli baar retry hogi):', e.message);
  }
}

// Aaj (19 Aug) 5 baje ka pass purane tareeke se chala tha — 8 message ek
// saath, Aumpfy ne sabko timeout kar diya, aur marker "bhej diya" bol kar
// baith gaya. Wo reminder kisi ko mile hi nahi. Ek baar dobara chalate hain,
// ab naye outbox raste se (ek-ek karke + retry).
async function refireTodays5pmReminder() {
  const MARKER = 'wa_refire_1700_20260819_v1';
  try {
    if (!waAutoAllowed()) return;
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const already = await d.findWhere('App_State', { key_name: MARKER });
    if (already && already.length) return;

    // Sirf usi din ke liye jiske liye ye banaya tha
    const ist = new Date(Date.now() + 330 * 60000);
    if (ist.toISOString().split('T')[0] !== '2026-08-19') {
      await d.insert('App_State', { key_name: MARKER, value: 'din nikal gaya, skip',
        updated_at: new Date().toISOString().replace('T', ' ').split('.')[0] });
      return;
    }

    await d.insert('App_State', {
      key_name: MARKER, value: 'refired',
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    const r = await runWhatsAppReminders('1700', true);   // force — marker ignore
    console.log('  ✅ 5 baje ka reminder dobara:', JSON.stringify(r));
  } catch (e) {
    console.error('  refireTodays5pmReminder error:', e.message);
  }
}

// Harsh, 22 Aug: "jo subah task delegate kiye the vo bhi jane chahiye."
// (21 Aug ko bhi yahi hua tha — wo marker consume ho chuka.) Subah purana
// API 404 de raha tha, isliye kuch delegate-alert unknown/failed me gaye. Ek baar ka backfill:
// AAJ bane delegation task utha kar har bande ko EK message jisme uske aaj ke
// saare task ginaye hon. Marker se sirf ek baar.
// 22 Aug: purana Aumpfy trigger subah se 404 de raha tha (Waumfy ne naya
// send-message API banate waqt use hata diya) — 404 = message PAKKA nahi
// gaya (timeout jaisa "shayad pahunch gaya" nahi). Isliye aaj ke atke
// unknown/failed rows ko naye API par ek saaf mauka: sirf AAJ bane rows,
// revivals bhi 0 (404-era me mauke bekaar jal gaye the). Baasi reminder
// waise bhi drain ka expiry-check rok dega.
// 22 Aug: Harsh ne manual reminder button dabaya — us waqt force pass bhi
// 'wa_pass_' marker likhta tha, jisse daily cap 2/2 bhar gaya aur shaam 5
// baje ka slot rukne wala tha. Ab force 'wa_manual_' likhta hai; ye ek baar
// aaj ke stray 'wa_pass_' markers (jo asli slot 1015/1700 ke nahi hain)
// hata deta hai taaki aaj ka 5 baje wala pakka chale.
// Harsh, 22 Aug ~12 baje: "jane do jldi se bhejo" — subah ka reminder poori
// list ko dobara. Maine duplicate ka bataya, unhone jaan-boojh kar haan kaha.
// Ek baar ka force pass (marker-gated), sirf aaj ke liye.
// 23 Aug shaam: 5 baje ka batch Waumfy ke "session warm-up" me phas gaya —
// nayi-judi session par pehle 30 min sirf 5 message. ~5 gaye, baaki failed
// (Waumfy ke andar; humari taraf "queued" hi dikha tha). Warm-up ~17:56 par
// khatam — isliye ye refire 18:00 IST tak rukta hai, phir poori list ko PM
// reminder dobara bhejta hai (per-banda PM dedup bypass karke). 19:00 se
// pehle nikal jaata hai.
// Harsh, 25 Aug subah: "phir se message bhejo, ye number chhod kar" — aaj ka
// AM reminder poori list ko dobara (919999298678 ab excluded hai, aur naya
// 80s gap laga hai jisse Waumfy ki queue me nahi fasenge). Ek baar ka.
async function refireAM25Aug() {
  const MARKER = 'wa_refire_am_20260825_v1';
  try {
    if (!waAutoAllowed()) return;
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
    if (todayIst !== '2026-08-25') {
      await d.insert('App_State', { key_name: MARKER, value: 'din nikal gaya, skip',
        updated_at: new Date().toISOString().replace('T', ' ').split('.')[0] });
      return;
    }

    await d.insert('App_State', {
      key_name: MARKER, value: 'refired',
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    const amRef = `rem_${todayIst}_AM`;
    const rows = await d.findAll('WA_Outbox');
    for (const r0 of rows) {
      if (r0.kind === 'daily-reminder' && r0.ref === amRef) {
        await d.update('WA_Outbox', r0.id, { ref: amRef + '_old' }).catch(() => {});
      }
    }
    const r = await runWhatsAppReminders(null, true);
    console.log('  ✅ AM reminder dobara (80s gap, excluded number ke bina):', JSON.stringify(r));
  } catch (e) {
    console.error('  refireAM25Aug error:', e.message);
  }
}

async function refirePM23Aug() {
  const MARKER = 'wa_refire_pm_20260823_v1';
  try {
    if (!waAutoAllowed()) return;
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const istNow = () => new Date(Date.now() + 330 * 60000);
    const todayIst = istNow().toISOString().split('T')[0];
    if (todayIst !== '2026-08-23') {
      await d.insert('App_State', { key_name: MARKER, value: 'din nikal gaya, skip',
        updated_at: new Date().toISOString().replace('T', ' ').split('.')[0] });
      return;
    }

    // 18:00 IST tak intezaar (warm-up ke baad). Marker abhi NAHI likhte —
    // beech me app restart ho jaye to agli baar phir se schedule ho jayega.
    const nowMin = istNow().getUTCHours() * 60 + istNow().getUTCMinutes();
    const waitMs = Math.max(0, (18 * 60 - nowMin) * 60000);
    if (waitMs > 0) {
      console.log(`  PM refire: warm-up ke baad chalega — ${Math.round(waitMs / 60000)} min intezaar (18:00 IST par)`);
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (istNow().getUTCHours() * 60 + istNow().getUTCMinutes() >= 19 * 60) return;   // 7 baje nikal gaya to rehne do

    const check = await d.findWhere('App_State', { key_name: MARKER });
    if (check && check.length) return;   // beech me kisi aur instance ne kar diya
    await d.insert('App_State', {
      key_name: MARKER, value: 'refired',
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    // Per-banda PM dedup bypass — aaj ke PM refs rename, sab fresh queue honge
    const pmRef = `rem_${todayIst}_PM`;
    const rows = await d.findAll('WA_Outbox');
    for (const r0 of rows) {
      if (r0.kind === 'daily-reminder' && r0.ref === pmRef) {
        await d.update('WA_Outbox', r0.id, { ref: pmRef + '_old' }).catch(() => {});
      }
    }
    const r = await runWhatsAppReminders(null, true);
    console.log('  ✅ 5 baje ka reminder dobara (warm-up ke baad):', JSON.stringify(r));
  } catch (e) {
    console.error('  refirePM23Aug error:', e.message);
  }
}

async function refireMorning22Aug() {
  const MARKER = 'wa_refire_am_20260822_v2';   // v1 dedup se ruk gaya tha
  try {
    if (!waAutoAllowed()) return;
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
    if (todayIst !== '2026-08-22') {
      await d.insert('App_State', { key_name: MARKER, value: 'din nikal gaya, skip',
        updated_at: new Date().toISOString().replace('T', ' ').split('.')[0] });
      return;
    }

    await d.insert('App_State', {
      key_name: MARKER, value: 'refired',
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    // Per-banda AM-dedup pehli koshish me sabko rok raha tha ("29 bande
    // skip"). Harsh ne saaf kaha dobara bhejo — to purane AM rows ka ref
    // rename kar do, dedup unhe dekhega hi nahi, sab fresh queue honge.
    // (Rows delete nahi karte — sent history bani rehti hai.)
    const todayRef = `rem_${todayIst}_AM`;
    const rows2 = await d.findAll('WA_Outbox');
    for (const r0 of rows2) {
      if (r0.kind === 'daily-reminder' && r0.ref === todayRef) {
        await d.update('WA_Outbox', r0.id, { ref: todayRef + '_old' }).catch(() => {});
      }
    }
    const r = await runWhatsAppReminders(null, true);   // force — Harsh ka bola hua
    console.log('  ✅ Subah ka reminder dobara (Harsh ke bolne par):', JSON.stringify(r));
  } catch (e) {
    console.error('  refireMorning22Aug error:', e.message);
  }
}

async function cleanStrayManualMarkers() {
  const MARKER = 'wa_clean_manual_marker_20260822_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
    const slotKeys = new Set(waSlots().map(x => `${x.h}${String(x.m || 0).padStart(2, '0')}`));
    const rows = await d.findAll('App_State');
    const prefix = `wa_pass_${todayIst}_`;
    let removed = 0;
    for (const r of rows) {
      const k = String(r.key_name || '');
      if (!k.startsWith(prefix)) continue;
      if (slotKeys.has(k.slice(prefix.length))) continue;   // asli slot marker — rehne do
      await d.delete('App_State', r.id).catch(() => {});
      removed++;
    }
    await d.insert('App_State', {
      key_name: MARKER, value: `removed ${removed}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    if (removed) console.log(`  ✅ ${removed} stray manual marker hataya — 5 baje ka slot ab pakka chalega`);
  } catch (e) {
    console.error('  cleanStrayManualMarkers error:', e.message);
  }
}

async function resendTodays404Casualties() {
  const MARKER = 'wa_resend_404_era_20260822_v1';
  try {
    if (!waAutoAllowed()) return;
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
    if (todayIst !== '2026-08-22') {
      await d.insert('App_State', { key_name: MARKER, value: 'din nikal gaya, skip',
        updated_at: new Date().toISOString().replace('T', ' ').split('.')[0] });
      return;
    }

    const rows = await d.findAll('WA_Outbox');
    const stuck = rows.filter(r =>
      (r.status === 'unknown' || r.status === 'failed') &&
      String(r.created_at || '').startsWith(todayIst));
    for (const r of stuck) {
      await d.update('WA_Outbox', r.id, {
        status: 'pending', attempts: '0', posts: '0', revivals: '0', last_error: ''
      }).catch(() => {});
    }
    await d.insert('App_State', {
      key_name: MARKER, value: `resent ${stuck.length}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    if (stuck.length) console.log(`  ✅ 404-era ke ${stuck.length} message ko naye API par naya mauka`);
    drainWhatsAppOutbox().catch(() => {});
  } catch (e) {
    console.error('  resendTodays404Casualties error:', e.message);
  }
}

async function backfillTodayMorningAssign() {
  const MARKER = 'wa_backfill_22aug_morning_v1';   // 21 Aug wala consume ho chuka
  try {
    if (!waAutoAllowed()) return;
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const todayIst = new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
    if (todayIst !== '2026-08-22') {
      await d.insert('App_State', { key_name: MARKER, value: 'din nikal gaya, skip',
        updated_at: new Date().toISOString().replace('T', ' ').split('.')[0] });
      return;
    }

    const delg = await d.findAll('Delegation_Tasks');
    const fresh = delg.filter(t => String(t.created_at || '').startsWith(todayIst));
    const byUser = {};
    for (const t of fresh) {
      const uid = String(t.assigned_to || '');
      if (!uid) continue;
      (byUser[uid] = byUser[uid] || []).push(t);
    }

    let queued = 0;
    for (const [uid, tasks] of Object.entries(byUser)) {
      const target = await getWhatsAppTarget(parseInt(uid));
      if (!target) continue;
      const lines = [
        '*Raabta Task Manager*', '',
        `Hello ${target.name || 'there'},`,
        `Here are the *${tasks.length} task(s)* delegated to you today:`, ''
      ];
      tasks.slice(0, 15).forEach((t, i) => {
        lines.push(`${i + 1}. ${t.description || ''}`);
        lines.push(`   Due: ${t.due_date || '-'} | Priority: ${t.priority || 'low'}`);
      });
      if (tasks.length > 15) lines.push(`...and ${tasks.length - 15} more`);
      lines.push('', 'Please complete them and mark as Done in the app.');
      const appUrl = process.env.APP_URL || '';
      if (appUrl) lines.push(`Open: ${appUrl}`);
      await queueWhatsApp(target.phone, lines.join('\n'), 'assign-backfill', MARKER, target.name, { immediate: false });
      queued++;
    }

    await d.insert('App_State', {
      key_name: MARKER, value: `queued ${queued} for ${fresh.length} task(s)`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ Aaj subah ke ${fresh.length} delegate task — ${queued} bande ko list queue hui`);
    drainWhatsAppOutbox().catch(() => {});
  } catch (e) {
    console.error('  backfillTodayMorningAssign error:', e.message);
  }
}

async function backfillMissedAssignAlerts() {
  const MARKER = 'wa_backfill_missed_assign_v1';
  try {
    if (!waAutoAllowed()) return;                  // sirf production
    if (!WA.enabled || !WA.url || !WA.apiKey) return;
    const d = await getDB();
    await ensureAppStateTab(d);
    const already = await d.findWhere('App_State', { key_name: MARKER });
    if (already && already.length) return;         // ho chuka

    // Pichhle 2 din (IST) me bane tasks
    const ist = new Date(Date.now() + 330 * 60000);
    const days = [0, 1].map(n => new Date(ist.getTime() - n * 86400000).toISOString().split('T')[0]);
    const isRecent = t => days.some(day => String(t.created_at || '').startsWith(day));

    const [delg, chk] = await Promise.all([
      d.findAll('Delegation_Tasks'), d.findAll('Checklist_Tasks')
    ]);
    const fresh = [
      ...delg.filter(isRecent).map(t => ({ ...t, kind: 'Delegation' })),
      ...chk.filter(isRecent).map(t => ({ ...t, kind: 'Checklist' }))
    ];

    // Bande ke hisaab se ikattha karo
    const byUser = {};
    for (const t of fresh) {
      const uid = String(t.assigned_to || '');
      if (!uid) continue;
      (byUser[uid] = byUser[uid] || []).push(t);
    }

    let queued = 0;
    for (const [uid, tasks] of Object.entries(byUser)) {
      const target = await getWhatsAppTarget(parseInt(uid));
      if (!target) continue;
      const lines = [
        '*Raabta Task Manager*', '',
        `Hello ${target.name || 'there'},`,
        `Here are the *${tasks.length} task(s)* assigned to you recently:`, ''
      ];
      tasks.slice(0, 15).forEach((t, i) => {
        lines.push(`${i + 1}. ${t.description || ''}`);
        lines.push(`   Due: ${t.due_date || '-'} | ${t.kind} | Priority: ${t.priority || 'low'}`);
      });
      if (tasks.length > 15) lines.push(`...aur ${tasks.length - 15} more`);
      lines.push('', 'Please complete them and mark as Done in the app.');
      const appUrl = process.env.APP_URL || '';
      if (appUrl) lines.push(`Open: ${appUrl}`);
      await queueWhatsApp(target.phone, lines.join('\n'), 'assign-backfill', '', target.name);
      queued++;
    }

    await d.insert('App_State', {
      key_name: MARKER,
      value: `queued ${queued} | recent ${fresh.length} (delg ${delg.length}, chk ${chk.length}) | days ${days.join(',')}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    console.log(`  ✅ Backfill: ${fresh.length} naye task, ${queued} bande ko alert queue hua`);
    drainWhatsAppOutbox().catch(() => {});
  } catch (e) {
    console.error('  Backfill error (agli baar retry hogi):', e.message);
  }
}

// ── General /:id routes AFTER all specific routes ──

app.delete('/api/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const type = req.body?.type || req.query.type;
    const skipCompleted = req.body?.skipCompleted || req.query.skipCompleted;
    const tabName = getTabName(type || 'delegation');
    if (skipCompleted === '1' || skipCompleted === 'true' || skipCompleted === true) {
      const task = await db.findOne(tabName, { id: req.params.id });
      if (task && task.status === 'completed')
        return res.status(400).json({ error: 'Completed tasks cannot be deleted in bulk', skipped: true });
    }
    await deleteRow(tabName, req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// APPROVALS
// ══════════════════════════════════════════════════════
app.get('/api/approvals', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    let approvals = await db.findAll('Task_Approvals');
    approvals = approvals.filter(a => a.status === 'pending');
    if (!isAdminOrPC) {
      approvals = approvals.filter(a => String(a.requested_to) === String(req.session.userId));
    }

    const result = [];
    for (const a of approvals) {
      let description = '', taskApproval = 'no';
      if (a.task_type === 'delegation') {
        const t = await db.findOne('Delegation_Tasks', { id: a.task_id });
        description = t?.description || '';
        taskApproval = t?.approval || 'no';
      } else {
        const t = await db.findOne('Checklist_Tasks', { id: a.task_id });
        description = t?.description || '';
      }
      result.push({
        ...a,
        id: parseInt(a.id),
        task_id: parseInt(a.task_id),
        requested_by: parseInt(a.requested_by),
        requested_to: parseInt(a.requested_to),
        requestedByName: userMap[String(a.requested_by)]?.name || '',
        requestedToName: userMap[String(a.requested_to)]?.name || '',
        description,
        taskApproval
      });
    }
    result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/approvals/count', requireAuth, async (req, res) => {
  try {
    const role = req.session.role;
    const isAdminOrPC = role === 'admin' || role === 'pc';
    let approvals = await db.findAll('Task_Approvals');
    approvals = approvals.filter(a => a.status === 'pending');
    if (!isAdminOrPC) approvals = approvals.filter(a => String(a.requested_to) === String(req.session.userId));
    res.json({ count: approvals.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/approvals/:id', requireAuth, async (req, res) => {
  try {
    const { action, note } = req.body;
    const role = req.session.role;
    const appr = await db.findOne('Task_Approvals', { id: req.params.id });
    if (!appr) return res.status(404).json({ error: 'Approval not found' });
    const canApprove = role === 'admin' || role === 'pc' || String(appr.requested_to) === String(req.session.userId);
    if (!canApprove) return res.status(403).json({ error: 'Not allowed' });
    await db.update('Task_Approvals', req.params.id, { status: action, note: note || '' });
    const tabName = getTabName(appr.task_type);
    if (action === 'approved') {
      // action_type hi naya status ban jaata hai. 'report' approve hua to task
      // Report tab me aata hai — was_reported bhi lagta hai (Reopen ke baad
      // Pending me highlight isi se hota hai).
      const upd = stamp(req, { status: appr.action_type, waiting_approval: '0' });
      if (appr.action_type === 'report') upd.was_reported = '1';
      // Purana status pehle padh lo, warna update ke baad pata nahi chalega
      const pehleKa = (await db.findOne(tabName, { id: appr.task_id }) || {}).status || '';
      await db.update(tabName, appr.task_id, upd);
      await logStatusChange(req, appr.task_type, appr.task_id, pehleKa, appr.action_type);
      // New-task approval (action_type 'pending'): ab jaake doer ko task dikha hai,
      // isliye WhatsApp bhi ab hi jaata hai (create ke waqt nahi gaya tha).
      if (WA.notifyOnAssign && appr.action_type === 'pending' && appr.task_type === 'delegation') {
        (async () => {
          const task = await db.findOne('Delegation_Tasks', { id: appr.task_id });
          if (!task) return;
          const assigner = await db.findOne('Users', { id: String(task.assigned_by) });
          const waTarget = await getWhatsAppTarget(parseInt(task.assigned_to));
          if (waTarget) {
            await queueWhatsApp(waTarget.phone, waDelegationMsg({
              assigneeName: waTarget.name, assignerName: assigner?.name || 'Admin',
              desc: task.description, dueDate: task.due_date,
              priority: task.priority || 'low', approval: task.approval || 'no', remarks: task.remarks || ''
            }), 'assign-approved', String(appr.task_id || ''), waTarget.name);
          }
        })().catch(e => console.error('  WA approve notify error:', e.message));
      }
    } else {
      const upd = { waiting_approval: '0' };
      // New-task reject: task doer ko kabhi nahi dikhna chahiye
      if (appr.action_type === 'pending') upd.status = 'rejected';
      await db.update(tabName, appr.task_id, upd);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// LEAVE REQUESTS
// ══════════════════════════════════════════════════════
// Apply leave — koi bhi logged-in user
app.post('/api/leaves', requireAuth, async (req, res) => {
  try {
    const { from_date, to_date, reason } = req.body || {};
    if (!from_date || !to_date) return res.status(400).json({ error: 'From aur To dates dono required hain' });
    if (to_date < from_date) return res.status(400).json({ error: 'To date From date se pehle nahi ho sakti' });
    const d = await getDB();
    await ensureLeaveTab(d);
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    const created = await d.insert('Leave_Requests', {
      user_id: String(req.session.userId), from_date, to_date,
      reason: reason || '', status: 'pending', note: '', created_at: nowStr
    });
    res.json({ success: true, id: parseInt(created.id) });

    // HR ko mail — fire-and-forget, response ko block nahi karta.
    // Do jagah se HR nikalta hai: .env ka HR_EMAIL, aur jinka role 'hr' hai.
    // Isliye Users me HR banate hi mail jaane lagti hai, env chhede bina.
    (async () => {
      const [allUsers, employee] = await Promise.all([
        d.findAll('Users'), d.findOne('Users', { id: String(req.session.userId) })
      ]);
      const targets = new Set(hrEmailList());
      for (const u of allUsers) {
        if (String(u.role || '').toLowerCase() !== 'hr') continue;
        const mail = String(u.notification_email || u.email || '').trim().toLowerCase();
        if (mail) targets.add(mail);
      }
      if (!targets.size) return;
      const days = Math.round((new Date(to_date) - new Date(from_date)) / 86400000) + 1;
      const subject = `Leave Request — ${employee?.name || 'Employee'} (${from_date} to ${to_date})`;
      const html = leaveRequestEmailHtml({ employeeName: employee?.name, fromDate: from_date, toDate: to_date, days, reason });
      for (const to of targets) await sendMail(to, subject, html, 'leave-request');
    })().catch(e => console.error('  Leave request email failed:', e.message));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List leaves — user ko apni, admin/PC ko sabki
app.get('/api/leaves', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    await ensureLeaveTab(d);
    const [leaves, users] = await Promise.all([d.findAll('Leave_Requests'), d.findAll('Users')]);
    const userMap = {};
    for (const u of users) userMap[String(u.id)] = u;
    // Role se ya HR_EMAIL se — dono me se koi bhi match kare to sabki dikhengi
    const me = userMap[String(req.session.userId)];
    const canSeeAll = canManageLeaves(req.session.role, me?.email, me?.notification_email);
    let list = leaves;
    if (!canSeeAll) list = leaves.filter(l => String(l.user_id) === String(req.session.userId));
    const result = list.map(l => ({
      ...l, id: parseInt(l.id), user_id: parseInt(l.user_id),
      userName: userMap[String(l.user_id)]?.name || ''
    })).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve / reject leave — admin / PC / HR
app.put('/api/leaves/:id', requireAuth, async (req, res) => {
  try {
    const { action, note } = req.body || {};
    if (action !== 'approved' && action !== 'rejected') return res.status(400).json({ error: 'Invalid action' });
    const d = await getDB();
    // Role se ya HR_EMAIL se — dono me se koi bhi match kare to allow
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!canManageLeaves(req.session.role, me?.email, me?.notification_email))
      return res.status(403).json({ error: 'Not allowed' });
    const leave = await d.findOne('Leave_Requests', { id: req.params.id });
    if (!leave) return res.status(404).json({ error: 'Leave request not found' });
    await d.update('Leave_Requests', req.params.id, { status: action, note: note || '' });

    // Employee ko decision mail. Ise await karte hain aur result response me
    // bhejte hain — taaki HR ko turant screen par dikhe ki mail gayi ya nahi,
    // aur kyun nahi (pehle ye chupchap fail hoti thi to pata hi nahi chalta tha).
    let mail = { sent: false, note: '' };
    try {
      const [employee, reviewer] = await Promise.all([
        d.findOne('Users', { id: String(leave.user_id) }),
        d.findOne('Users', { id: String(req.session.userId) })
      ]);
      // Doer ke DONO address par bhejo — notification_email aur login wali
      // email. Pehle sirf notification_email par jaati thi, aur usme purana ya
      // galat address pada ho (Users page par wo dikhta bhi nahi) to mail
      // chupchap kahin aur chali jaati thi. Dono same ho to ek hi jaayegi.
      const tos = [...new Set(
        [employee?.notification_email, employee?.email]
          .map(e => String(e || '').trim()).filter(Boolean)
          .map(e => e.toLowerCase())
      )];
      if (!tos.length) {
        mail.note = `${employee?.name || 'Doer'} ki koi email app me nahi hai — Users page me daalo`;
      } else {
        const days = Math.round((new Date(leave.to_date) - new Date(leave.from_date)) / 86400000) + 1;
        const label = action === 'approved' ? 'Approved' : 'Rejected';
        const html = leaveDecisionEmailHtml({
          employeeName: employee.name, fromDate: leave.from_date, toDate: leave.to_date,
          days, action, note: note || '', reviewerName: reviewer?.name
        });
        const subject = `Leave Request ${label} — ${leave.from_date} to ${leave.to_date}`;
        const ok = [], bad = [];
        for (const to of tos) {
          const r = await sendMail(to, subject, html, 'leave-decision');
          if (r && r.ok) ok.push(to);
          else bad.push(`${to}: ${(r && (r.error || r.skipped)) || 'unknown'}`);
        }
        mail.sent = ok.length > 0;
        mail.note = ok.length
          ? `Mail bhej di — ${ok.join(', ')}` + (bad.length ? ` (fail: ${bad.join('; ')})` : '')
          : `Mail fail — ${bad.join('; ')}`;
      }
    } catch (e) {
      mail.note = 'Mail error: ' + e.message;
    }
    if (!mail.sent) console.error('  Leave decision email:', mail.note);

    res.json({ success: true, mail });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// HR REPORTING — biometric attendance Excel upload + review
// ══════════════════════════════════════════════════════
const HR_LOCATIONS = ['store', 'office', 'karigar'];

// Sheets-mode fallback: HR_Attendance tab na ho to bana do (MySQL me schema
// se apne aap ban jaata hai)
async function ensureHRTab(d) {
  if (!d.sheets || !d._hdrCache) return;   // MySQL driver — kuch nahi karna
  try {
    await d.findAll('HR_Attendance');
  } catch (e) {
    try {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'HR_Attendance' } } }] }
      }));
    } catch (e2) { /* already exists race */ }
    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'HR_Attendance!A1:R1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['id','location','emp_id','emp_name','department','att_date','punch_in','punch_out','punch_in2','punch_out2','late_min','early_min','absence_min','total_min','note','manual','uploaded_by','created_at']] }
    }));
    delete d._hdrCache['HR_Attendance'];
    delete d._cache['HR_Attendance'];
  }
}

// HR Reporting SIRF Admin aur HR ke liye — PC/HOD ko nahi.
// HR = role 'hr' YA jiska email HR_EMAIL/default HR list se match kare
// (Samridhi ka role kuch bhi ho, email se pehchan ho jaati hai).
function isHrReportUser(role, email, notificationEmail) {
  const r = String(role || '').trim().toLowerCase();
  if (r === 'admin' || r === 'hr') return true;
  const mine = [email, notificationEmail].map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
  return hrEmailList().some(hr => mine.includes(hr));
}
async function hrReportAllowed(req) {
  const d = await getDB();
  const me = await d.findOne('Users', { id: String(req.session.userId) });
  return isHrReportUser(req.session.role, me?.email, me?.notification_email);
}

// ══ ONBOARDING_FMS_START ══
// HR Reporting = Employee Onboarding FMS (Harsh, 22 Oct). Purana attendance
// (Excel upload) screen se hata diya -- uske routes aur data waise hi pade hain.
// Workflow "onboarding_workflow_flowchart.pdf" ka: 4 phase, 20 step (+ Step 1 Data Inputs = 21).
// FMS jaisa SEQUENTIAL: "Employee master form" ki entry banti hai, wo Step 1
// ke doer ke paas jaati hai; Step 1 Done hone par hi Step 2 khulta hai, aur
// aise hi aage (N/A wale step chhod kar). Har step ki plan date joining date se:
//   off = -7 -> "7 din pehle", 0 -> Day 1, +3 -> "3 din ke andar",
//   'probation' -> joining + us employee ke probation ke din.
// Doer: app ka user (dropdown) ya haath se likha naam (jiska account nahi --
// uska step Admin / HR Done karte hain).
// Harsh (23 Oct): Step 1 "Initial Candidate Details" = entry form (name,
// designation, phone, alternate phone, resume, portfolio, intro video) -- save
// hote hi complete. Step 2 "Director Review": Director details + files dekh kar
// remarks ke saath Approve ya Reject (Reject = flow band). Step 3 "Remaining
// Employee Details": HR email, location, DOB, ESIS, contract, probation, ref. by,
// notes bharta hai -- iske baad details LOCK. Admin / ijazat wale user wajah likh
// kar Unlock kar sakte hain; har edit / unlock / lock ki history (HR_Onboarding_Audit).
// Naye step aane par purane step aage khiske -- obReady() ek baar shift karta hai.
const OB_PHASES = [
  { no: 1, title: 'Before Joining', color: '#2e8b65' },
  { no: 2, title: 'Day 1 - Induction & Setup', color: '#2f66b3' },
  { no: 3, title: 'First 3–5 Days', color: '#a66a12' },
  { no: 4, title: 'First Week & Probation', color: '#7b5ab6' }
];
const OB_STEPS = [
  { no: 1, phase: 1, title: 'Initial Candidate Details', owner: 'HR Team', channel: 'Employee entry form', note: 'Employee name, designation, phone, alternate phone, resume, portfolio, intro video', when: 'Entry ke saath', off: null, dataInputs: true },
  { no: 2, phase: 1, title: 'Director Review', owner: 'Director', channel: 'Onboarding system / Google Meet', note: 'Candidate details aur resume / portfolio / intro video dekh kar remarks ke saath Approve ya Reject - Reject ya pending par aage nahi badhta', when: 'Step 1 ke baad', off: null, interview: true },
  { no: 3, phase: 1, title: 'Remaining Employee Details', owner: 'HR Team', channel: 'Onboarding system', note: 'Email, location, date of birth, ESIS, contract signed, probation days, ref. by, notes, documents (file) - Step 1 ki details bhi yahin edit ho sakti hain', when: 'Director approval ke baad', off: null, empDetails: true },
  { no: 4, phase: 1, title: 'Collect documents', owner: 'HR Team', channel: 'Email; CC Director, Logistics Head, EA and Marketing Head', when: '7 days before joining', off: -7 },
  { no: 5, phase: 1, title: 'Reference check + alternate contact numbers', owner: 'HR Team', channel: 'Email + update Google Sheets', when: '5 days before joining', off: -5 },
  { no: 6, phase: 1, title: 'Send offer letter', owner: 'HR Team', channel: 'Email', when: '2 days before joining', off: -2 },
  { no: 7, phase: 1, title: 'Create official email account', owner: 'EA', channel: 'Email', when: '3 days before joining', off: -3 },
  { no: 8, phase: 1, title: 'Share systems introduction + training videos', owner: 'MIS Executive', channel: 'Official email only', when: '3 days before joining', off: -3, checklist: [{ id: 'intro', label: 'Introduction to systems and training videos via official email only' }, { id: 'delegation', label: 'Install delegation and checklist dashboard' }, { id: 'forms', label: 'Add names to all Google Forms under "Employee Name"' }] },
  { no: 9, phase: 2, title: 'Induction meeting', owner: 'HR Team', channel: 'Google Meet', note: 'Cover policies, attendance, rewards, organisation chart, grievance, reimbursement, rules and bond/NDA', when: 'Day 1', off: 0, checklist: [{ id: 'meet', label: 'Conduct induction over Google Meet' }, { id: 'fine', label: 'Explain fine policy' }, { id: 'reward', label: 'Explain employee reward policy' }, { id: 'attendance', label: 'Explain attendance rules' }, { id: 'orgchart', label: 'Explain organisational chart' }, { id: 'grievance', label: 'Explain grievance form' }, { id: 'reimb', label: 'Explain reimbursement system and rules' }, { id: 'bond', label: 'Confirm bond and NDA' }] },
  { no: 10, phase: 2, title: 'Sign offer letter + onboarding documents', owner: 'HR Team', channel: 'In person; scan/email signed copies', when: 'Day 1', off: 0, checklist: [{ id: 'offer', label: 'Collect signed offer letter' }, { id: 'form_person', label: 'Complete onboarding form in person' }, { id: 'form_mail', label: 'Send onboarding form to HR' }] },
  { no: 11, phase: 2, title: 'Create employee profile + add name to all forms', owner: 'MIS', channel: 'Onboarding system', note: 'Include all forms and Mumbai forms; verify the employee name and access', when: 'Day 1', off: 0 },
  { no: 12, phase: 2, title: 'Enroll fingerprint attendance', owner: 'Naresh (Delhi) / Mumbai process owner', channel: 'In person / training video', when: 'Day 1', off: 0, byLocation: true },
  { no: 13, phase: 2, title: 'Introduce team + office/store tour', owner: 'Bajji (Delhi) / Anisha (Mumbai)', channel: 'Physical tour', when: 'Day 1', off: 0, byLocation: true },
  { no: 14, phase: 2, title: 'Handover assets', owner: 'Ashok SN', channel: 'In person with acknowledgement', note: 'Assets: stationery, laptop, workspace and phone, as applicable', when: 'Day 1', off: 0 },
  { no: 15, phase: 2, title: 'Add to Happy Group + relevant WhatsApp groups', owner: 'EA / HR', channel: 'WhatsApp', note: 'Include Director group(s) and relevant role/location groups; confirm access', when: 'Day 1', off: 0, checklist: [{ id: 'happy', label: 'Add employee to Happy Group' }, { id: 'numbers', label: 'Add personal and professional contact numbers' }, { id: 'birthday', label: 'Add employee birthday to calendar' }] },
  { no: 16, phase: 2, title: 'Add birthday to calendar', owner: 'EA', channel: 'Calendar', when: 'Day 1', off: 0 },
  { no: 17, phase: 2, title: 'Install/access Delegation + Checklist Dashboard', owner: 'MIS', channel: 'Onboarding system / employee device', note: 'Verify login, permissions and dashboard visibility', when: 'Day 1', off: 0 },
  { no: 18, phase: 3, title: 'Transfer MIS tasks', owner: 'MIS', channel: 'Transfer from existing user to new user', when: 'Within 3 days of joining', off: 3, checklist: [{ id: 'tasks_transfer', label: 'Transfer MIS tasks from existing user to new user' }, { id: 'tasks_both', label: 'Complete checklist and delegation task transfer' }] },
  { no: 19, phase: 3, title: 'Update website appointment section (sales employees)', owner: 'MIS', channel: 'Email to support@apixelhouse.com', when: 'Within 5 days of joining', off: 5, salesOnly: true },
  { no: 20, phase: 3, title: 'Meeting with CEO', owner: 'Director / CEO', channel: 'Physical or virtual', when: 'Within 3 days of joining', off: 3, checklist: [{ id: 'ceo_meet', label: 'Schedule meeting with CEO' }, { id: 'wapp', label: 'Add employee to Director WhatsApp groups' }] },
  { no: 21, phase: 4, title: 'Enroll for ESIS / PCC', owner: 'HR Team', channel: 'In person', when: 'Within 1 week of joining', off: 7, esisOnly: true },
  { no: 22, phase: 4, title: 'Issue and collect joining letter', owner: 'HR Team', channel: 'Email', when: 'After probation', off: 'probation' }
];
const OB_DI_NO = OB_STEPS.find(d => d.dataInputs).no;     // Step 1 -- Initial Candidate Details
const OB_IV_NO = OB_STEPS.find(d => d.interview).no;      // Step 2 -- Director Review
const OB_EMP_NO = OB_STEPS.find(d => d.empDetails).no;    // Step 3 -- Remaining Employee Details
const OB_LOCATIONS = ['Delhi', 'Mumbai'];
const OB_CONTROL = 'HR tracks completion • MIS verifies system access • Employee confirms receipt and access';

function obNowIST() { return new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0]; }
function obTodayIST() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
function obAddDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function obPlan(def, j) {
  if (def.off == null || !isRealDate(j.joining_date)) return '';
  const off = def.off === 'probation' ? (parseInt(j.probation_days, 10) || 90) : def.off;
  return obAddDays(j.joining_date, off);
}
// Ye step is joinee par lagu hai? (19 sirf Sales; 21 ESIS -- sirf "No" par N/A,
// haath se likha jawab ho to step rehta hai)
function obApplies(def, j) {
  if (def.salesOnly && String(j.is_sales || '').toLowerCase() !== 'yes') return false;
  if (def.esisOnly && String(j.esis || '').toLowerCase() === 'no') return false;
  return true;
}
async function obWho(req) {
  const me = await db.findOne('Users', { id: String(req.session.userId) });
  return { me, uid: String(req.session.userId), canManage: !!me && isHrReportUser(req.session.role, me.email, me.notification_email) };
}
// Step ka default doer: location wale step (12, 13) ke liye us location ka
function obOwnerFor(owners, no, loc) {
  const o = owners.find(x => String(x.step_no) === String(no) && String(x.location || '') === String(loc || '') && (x.doer_id || x.doer_name));
  return o ? { doer_id: String(o.doer_id || ''), doer_name: o.doer_id ? '' : String(o.doer_name || '') } : { doer_id: '', doer_name: '' };
}
// /api/me ke liye: kya is bande ka koi onboarding step hai (tab dikhana hai ya nahi)
async function obUserHasSteps(user) {
  try {
    if (isHrReportUser(user.role, user.email, user.notification_email)) return true;
    const uid = String(user.id);
    if (db && db.pool) {
      const [r] = await db.pool.query('SELECT COUNT(*) AS n FROM `HR_Onboarding_Steps` WHERE doer_id = ?', [uid]);
      return (parseInt(r[0] && r[0].n, 10) || 0) > 0;
    }
    return (await db.findAll('HR_Onboarding_Steps')).some(s => String(s.doer_id) === uid);
  } catch (e) { return false; }
}
const obDigits = v => String(v == null ? '' : v).replace(/\D/g, '');
// Step ki checklist (JSON) -- { itemId: { at, by, byName } }
function obParseChecks(v) {
  try { const o = JSON.parse(String(v || '{}')); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
}
// App ko sirf us step ke apne points ke tick bhejte hain
function obChecksOut(def, v) {
  const cl = obParseChecks(v), out = {};
  (def.checklist || []).forEach(c => { if (cl[c.id]) out[c.id] = { at: cl[c.id].at || '', byName: cl[c.id].byName || '' }; });
  return out;
}
// Employee master form -- naya ya edit (edit me jo nahi bheja wo purana rehta hai)
function obClean(b, old) {
  const v = (k, col, max) => String(b[k] != null ? b[k] : (old ? old[col] || '' : '')).trim().slice(0, max);
  // Yes / No -- ya haath se likha jawab (dropdown ka "Other")
  const yn = (k, col) => { const x = String(b[k] != null ? b[k] : (old ? old[col] || '' : '')).trim().slice(0, 60); const l = x.toLowerCase(); return l === 'yes' ? 'yes' : l === 'no' ? 'no' : x; };
  const naIn = b.altPhoneNA != null ? b.altPhoneNA : (old ? old.alt_phone_na === '1' : false);
  const altNA = naIn === true || String(naIn) === '1' || String(naIn).toLowerCase() === 'true';
  const prob = parseInt(b.probationDays != null ? b.probationDays : (old ? old.probation_days : 90), 10);
  const f = {
    name: v('name', 'name', 120),
    designation: v('designation', 'designation', 120),
    phone: v('phone', 'phone', 30),
    email: v('email', 'email', 150).toLowerCase(),
    ref_by: v('refBy', 'ref_by', 150),
    resume_link: v('resumeLink', 'resume_link', 500),
    portfolio_link: v('portfolioLink', 'portfolio_link', 500),
    video_link: v('videoLink', 'video_link', 500),
    alt_phone: altNA ? '' : v('altPhone', 'alt_phone', 30),
    alt_phone_na: altNA ? '1' : '0',
    salary: v('salary', 'salary', 30),
    location: v('location', 'location', 60),
    dob: toIsoDateSrv(b.dob != null ? b.dob : (old ? old.dob : '')),
    joining_date: toIsoDateSrv(b.joiningDate != null ? b.joiningDate : (old ? old.joining_date : '')),
    esis: yn('esis', 'esis'),
    contract: yn('contract', 'contract'),
    docs_collected: yn('docsCollected', 'docs_collected'),
    probation_days: String(Number.isInteger(prob) && prob > 0 && prob <= 730 ? prob : 90),
    notes: String(b.notes != null ? b.notes : (old ? old.notes || '' : '')).trim().slice(0, 2000)
  };
  f.is_sales = /sales/i.test(f.designation) ? 'yes' : 'no';
  return f;
}
const obIsUrl = v => /^https?:\/\/[^\s]+$/i.test(String(v || ''));
const obEmailOk = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
// Resume / portfolio / video ka link ho to http(s) wala hi
function obLinkBad(f) {
  if (f.resume_link && !obIsUrl(f.resume_link)) return 'Resume link sahi daalo (https://...)';
  if (f.portfolio_link && !obIsUrl(f.portfolio_link)) return 'Portfolio link sahi daalo (https://...)';
  if (f.video_link && !obIsUrl(f.video_link)) return 'Intro video link sahi daalo (https://...)';
  return '';
}
// Step 1 "Initial Candidate Details" (entry form / edit)
function obCheck(f) {
  if (!f.name) return 'Employee name daalo';
  if (!f.designation) return 'Designation chuno ya likho';
  const pd = obDigits(f.phone);
  if (!/^\d{10}$/.test(String(f.phone))) return 'Phone sahi daalo (sirf 10 digit ka number)';
  if (f.alt_phone_na !== '1') {
    const ad = obDigits(f.alt_phone);
    if (!ad) return 'Alternate phone daalo, ya "Not available" tick karo';
    if (!/^\d{10}$/.test(String(f.alt_phone))) return 'Alternate phone sahi daalo (sirf 10 digit ka number)';
  }
  return obLinkBad(f);
}
// Step 3 "Remaining Employee Details"
function obCheckEmp(f) {
  if (!f.email) return 'Email daalo';
  if (!obEmailOk(f.email)) return 'Email sahi daalo';
  if (!f.location) return 'Location chuno ya likho';
  if (!f.dob) return 'Date of birth sahi daalo';
  if (f.joining_date && f.dob >= f.joining_date) return 'Date of birth joining se pehle honi chahiye';
  if (!f.esis) return 'ESIS eligible? -- chuno ya likho';
  if (!f.contract) return 'Contract signed? -- chuno ya likho';
  return '';
}
const OB_STEP1_KEYS = ['name', 'designation', 'phone', 'altPhone', 'altPhoneNA', 'resumeLink', 'portfolioLink', 'videoLink'];
const OB_EMP_KEYS = ['email', 'location', 'dob', 'esis', 'contract', 'docsCollected', 'probationDays', 'refBy', 'notes'];
const obPick = (b, keys) => { const o = {}; keys.forEach(k => { if (b[k] !== undefined) o[k] = b[k]; }); return o; };
// Interview ka nateeja -- purani entry jisme Interview Done tha = selected
function obInterview(j, ivRow) {
  if (j.interview) return String(j.interview);
  return ivRow && String(ivRow.done) === '1' ? 'selected' : '';
}
// Designation / location / ESIS badle to chalu entry ke pending step: Sales
// (19) / ESIS (21) lagu ya N/A, location wale step (12, 13) ka doer
async function obSyncSteps(jOld, f, now) {
  const steps = await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(jOld.id) });
  const owners = await db.findAll('HR_Onboarding_Owners');
  for (const s of steps) {
    const def = OB_STEPS.find(d => String(d.no) === String(s.step_no));
    if (!def || String(s.done) === '1') continue;
    const su = {};
    if (def.salesOnly || def.esisOnly) { const na = obApplies(def, f) ? '0' : '1'; if (String(s.na) !== na) su.na = na; }
    if (def.byLocation && f.location !== jOld.location) {
      const o = obOwnerFor(owners, def.no, f.location);
      if ((o.doer_id || o.doer_name) && (o.doer_id !== String(s.doer_id || '') || o.doer_name !== String(s.doer_name || ''))) {
        su.doer_id = o.doer_id; su.doer_name = o.doer_name;
      }
    }
    if (Object.keys(su).length) { su.updated_at = now; await db.update('HR_Onboarding_Steps', String(s.id), su); }
  }
}
// Is user ka in step me se koi doer hai?
async function obIsDoer(jid, uid, nos) {
  return (await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(jid) }))
    .some(s => nos.map(String).includes(String(s.step_no)) && String(s.doer_id || '') === String(uid));
}
// Audit history: kaun, kab, kya badla (field: purana -> naya)
const OB_LABELS = { name: 'Name', designation: 'Designation', phone: 'Phone', alt_phone: 'Alternate phone', alt_phone_na: 'Alternate N/A',
  resume_link: 'Resume link', portfolio_link: 'Portfolio link', video_link: 'Intro video link', email: 'Email', location: 'Location',
  dob: 'Date of birth', esis: 'ESIS', contract: 'Contract signed', docs_collected: 'Documents collected', probation_days: 'Probation', ref_by: 'Ref. by', notes: 'Notes' };
function obDiff(old, f) {
  return Object.keys(OB_LABELS).filter(k => f[k] !== undefined && String(f[k] == null ? '' : f[k]) !== String(old[k] == null ? '' : old[k]))
    .map(k => OB_LABELS[k] + ': ' + (String(old[k] || '') || '-') + ' → ' + (String(f[k] || '') || '-')).join('; ');
}
async function obAudit(jid, action, details, me, uid) {
  try {
    await db.insert('HR_Onboarding_Audit', { onboarding_id: String(jid), action: String(action), details: String(details || '').slice(0, 4000),
      by_id: String(uid || ''), by_name: (me && me.name) || '', created_at: obNowIST() });
  } catch (e) { console.error('  onboarding audit:', e.message); }
}
// Lock: Step 3 complete hote hi. Unlock: Admin, ya jinhe Admin ne Step Admin me ijazat di
// Harsh (24 Oct): lock hata diya -- Step 3 ke baad bhi Admin / HR details edit kar sakte hain
const obLocked = j => false;
const OB_LOCK_MSG = 'Details lock hain (Step 3 complete) -- pehle Unlock karo';
const OB_UNLOCK_KEY = 'onboarding_unlockers';
async function obUnlockers() {
  try {
    const r = (await db.findWhere('App_State', { key_name: OB_UNLOCK_KEY }))[0];
    const a = JSON.parse((r && r.value) || '[]');
    return Array.isArray(a) ? a.map(String) : [];
  } catch (e) { return []; }
}
async function obCanUnlock(req) { return req.session.role === 'admin' || (await obUnlockers()).includes(String(req.session.userId)); }
// Candidate ki files: resume / portfolio / intro video (ya inki jagah link).
// Harsh (23 Oct): "kitne bhi MB" -- file 4 MB ke tukdon me aati hai, isliye size
// ki chhoti limit nahi; bas ek file 500 MB tak (isse badi ho to link).
const OB_FILE_KINDS = {
  resume:    { label: 'Resume', exts: ['pdf', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'webp'] },
  portfolio: { label: 'Portfolio', exts: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'webp'] },
  video:     { label: 'Intro video', exts: ['mp4', 'mov', 'webm', 'mkv', '3gp', 'avi', 'm4v'] },
  // Step 3 -- baaki sab jaise: PDF / Word / PPT / image / video
  documents: { label: 'Documents', exts: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'webm', 'mkv', '3gp', 'avi', 'm4v'] }
};
const OB_FILE_MAX_MB = 500;
const OB_CHUNK_B64_MAX = 8 * 1024 * 1024;        // ek tukda (base64) -- app 4 MB ke bhejta hai
// Files ki list bina data ke (data bhaari hai -- sirf kholne par). Sirf poori upload hui.
async function obFileMeta(jid) {
  if (db && db.pool) {
    const cols = 'SELECT id, onboarding_id, kind, file_name, mime_type, file_size, created_at FROM `HR_Onboarding_Files` WHERE complete <> \'0\'';
    const [r] = jid ? await db.pool.query(cols + ' AND onboarding_id = ?', [String(jid)]) : await db.pool.query(cols);
    return r;
  }
  return (await db.findAll('HR_Onboarding_Files')).filter(x => String(x.complete) !== '0' && (!jid || String(x.onboarding_id) === String(jid)))
    .map(x => ({ id: x.id, onboarding_id: x.onboarding_id, kind: x.kind, file_name: x.file_name, mime_type: x.mime_type, file_size: x.file_size, created_at: x.created_at }));
}
// Kind / extension sahi? (ext na mile to video ke liye mime se)
function obFileTypeBad(kind, fileName, mime) {
  const spec = OB_FILE_KINDS[kind];
  if (!spec) return 'File type galat hai';
  const ext = (String(fileName || '').split('.').pop() || '').toLowerCase();
  if (spec.exts.includes(ext) || (kind === 'video' && String(mime || '').startsWith('video/'))) return '';
  return spec.label + ': ye file type nahi chalega (' + spec.exts.join(', ') + ')';
}
// Step 1 "Data Inputs" aane se purane step ek number aage khiske (Interview 1 -> 2,
// ... Joining letter 20 -> 21). Pehle se bani entries ke step aur Step Admin ke
// doer / TAT EK BAAR shift (App_State marker). Purani entry me koi step Done ho
// chuka ho to uska Data Inputs N/A, warna wo Data Inputs se shuru hoti hai.
const OB_SHIFT_MARKER = 'onboarding_data_inputs_step1_v1';
let _obShift = null;
function obReady() {
  if (!_obShift) _obShift = obWidenCols().then(obShiftOnce).then(obShift2Once).catch(e => { _obShift = null; throw e; });
  return _obShift;
}
// ESIS / Contract me ab haath se likha jawab bhi aata hai -- purani table me ye
// VARCHAR(5) (sirf yes/no) the, ek baar 60 kar do
async function obWidenCols() {
  if (!db.pool) return;
  const [cols] = await db.pool.query("SELECT COLUMN_NAME AS c, CHARACTER_MAXIMUM_LENGTH AS len FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HR_Onboarding' AND COLUMN_NAME IN ('esis', 'contract')");
  for (const x of cols) {
    if ((parseInt(x.len, 10) || 0) < 60) await db.pool.query('ALTER TABLE `HR_Onboarding` MODIFY `' + x.c + "` VARCHAR(60) DEFAULT ''");
  }
  // Tukde file_id se dhoondhte hain -- index (ek baar)
  const [ix] = await db.pool.query("SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'HR_Onboarding_Chunks' AND INDEX_NAME = 'idx_ob_chunk_file'");
  if (!ix.length) await db.pool.query('CREATE INDEX idx_ob_chunk_file ON `HR_Onboarding_Chunks` (file_id)');
}
async function obShiftOnce() {
  await ensureAppStateTab(db);
  if ((await db.findWhere('App_State', { key_name: OB_SHIFT_MARKER })).length) return;
  const now = obNowIST();
  let joinees = await db.findAll('HR_Onboarding');
  let steps = await db.findAll('HR_Onboarding_Steps');
  const anyDone = j => steps.some(s => String(s.onboarding_id) === String(j.id) && String(s.done) === '1');
  const newRow = j => ({ onboarding_id: String(j.id), step_no: String(OB_DI_NO), doer_id: '', doer_name: '', done: '0', done_at: '', done_by: '', done_by_name: '',
    note: anyDone(j) ? 'Purani entry -- Data Inputs step baad me juda' : '', na: anyDone(j) ? '1' : '0', updated_at: now });
  if (db.pool) {
    // Lock: do process ek saath start hon to bhi shift ek hi baar. Transaction:
    // beech me ruke to kuch bhi aadha na khiske.
    const conn = await db.pool.getConnection();
    try {
      await conn.query("SELECT GET_LOCK('raabta_ob_shift', 30)");
      const [mk] = await conn.query('SELECT id FROM `App_State` WHERE key_name = ?', [OB_SHIFT_MARKER]);
      if (mk.length) return;
      [joinees] = await conn.query('SELECT id FROM `HR_Onboarding`');
      [steps] = await conn.query('SELECT onboarding_id, done FROM `HR_Onboarding_Steps`');
      await conn.beginTransaction();
      for (const t of ['HR_Onboarding_Steps', 'HR_Onboarding_Owners']) {
        await conn.query('UPDATE `' + t + "` SET step_no = CAST(CAST(step_no AS UNSIGNED) + 1 AS CHAR) WHERE step_no REGEXP '^[0-9]+$'");
      }
      for (const j of joinees) {
        const r = newRow(j);
        await conn.query('INSERT INTO `HR_Onboarding_Steps` (' + Object.keys(r).join(', ') + ') VALUES (' + Object.keys(r).map(() => '?').join(', ') + ')', Object.values(r));
      }
      await conn.query('INSERT INTO `App_State` (key_name, value, updated_at) VALUES (?, ?, ?)', [OB_SHIFT_MARKER, joinees.length + ' entry shift', now]);
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
    finally { try { await conn.query("SELECT RELEASE_LOCK('raabta_ob_shift')"); } catch (_) {} conn.release(); }
    ['HR_Onboarding_Steps', 'HR_Onboarding_Owners', 'App_State'].forEach(t => db._invalidate(t));
  } else {
    for (const s of steps) if (/^\d+$/.test(String(s.step_no))) await db.update('HR_Onboarding_Steps', String(s.id), { step_no: String(parseInt(s.step_no, 10) + 1) });
    for (const o of await db.findAll('HR_Onboarding_Owners')) if (/^\d+$/.test(String(o.step_no))) await db.update('HR_Onboarding_Owners', String(o.id), { step_no: String(parseInt(o.step_no, 10) + 1) });
    if (joinees.length) await db.batchInsert('HR_Onboarding_Steps', joinees.map(newRow));
    await db.insert('App_State', { key_name: OB_SHIFT_MARKER, value: joinees.length + ' entry shift', updated_at: now });
  }
  console.log('  \u2705 onboarding: Step 1 Data Inputs -- ' + joinees.length + ' purani entry ke step shift');
}
// Step 3 "Remaining Employee Details" aane se (23 Oct) Step 3 aur aage ke step ek number
// aage (Collect documents 3 -> 4 ... Joining letter 21 -> 22) -- entries, Step Admin
// ke doer aur TAT, EK BAAR. Purani entry jisme email / location / DOB / ESIS / contract
// bhare hain: Step 3 Done + lock (history me likha); warna Step 3 pending.
const OB_SHIFT2_MARKER = 'onboarding_emp_details_step3_v1';
async function obShift2Once() {
  await ensureAppStateTab(db);
  if ((await db.findWhere('App_State', { key_name: OB_SHIFT2_MARKER })).length) return;
  const now = obNowIST();
  let joinees = await db.findAll('HR_Onboarding');
  const full = j => !!(j.email && j.location && j.dob && j.esis && j.contract);
  const newRow = j => ({ onboarding_id: String(j.id), step_no: String(OB_EMP_NO), doer_id: '', doer_name: '',
    done: full(j) ? '1' : '0', done_at: full(j) ? now : '', done_by: '', done_by_name: full(j) ? 'System' : '',
    note: full(j) ? 'Purani entry -- details pehle se bhari thi' : '', na: '0', updated_at: now });
  const auditRow = j => ({ onboarding_id: String(j.id), action: 'lock', details: 'Step 3 (Remaining Employee Details) juda -- details pehle se bhari thi, isliye lock',
    by_id: '', by_name: 'System', created_at: now });
  const ins = async (conn, t, r) => conn.query('INSERT INTO `' + t + '` (' + Object.keys(r).join(', ') + ') VALUES (' + Object.keys(r).map(() => '?').join(', ') + ')', Object.values(r));
  if (db.pool) {
    const conn = await db.pool.getConnection();
    try {
      await conn.query("SELECT GET_LOCK('raabta_ob_shift', 30)");
      const [mk] = await conn.query('SELECT id FROM `App_State` WHERE key_name = ?', [OB_SHIFT2_MARKER]);
      if (mk.length) return;
      [joinees] = await conn.query('SELECT id, email, location, dob, esis, contract FROM `HR_Onboarding`');
      await conn.beginTransaction();
      for (const t of ['HR_Onboarding_Steps', 'HR_Onboarding_Owners']) {
        await conn.query('UPDATE `' + t + "` SET step_no = CAST(CAST(step_no AS UNSIGNED) + 1 AS CHAR) WHERE step_no REGEXP '^[0-9]+$' AND CAST(step_no AS UNSIGNED) >= ?", [OB_EMP_NO]);
      }
      for (const j of joinees) {
        await ins(conn, 'HR_Onboarding_Steps', newRow(j));
        if (full(j)) {
          await conn.query("UPDATE `HR_Onboarding` SET locked = '1' WHERE id = ?", [j.id]);
          await ins(conn, 'HR_Onboarding_Audit', auditRow(j));
        }
      }
      await conn.query('INSERT INTO `App_State` (key_name, value, updated_at) VALUES (?, ?, ?)', [OB_SHIFT2_MARKER, joinees.length + ' entry shift', now]);
      await conn.commit();
    } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
    finally { try { await conn.query("SELECT RELEASE_LOCK('raabta_ob_shift')"); } catch (_) {} conn.release(); }
    ['HR_Onboarding', 'HR_Onboarding_Steps', 'HR_Onboarding_Owners', 'HR_Onboarding_Audit', 'App_State'].forEach(t => db._invalidate(t));
  } else {
    for (const t of ['HR_Onboarding_Steps', 'HR_Onboarding_Owners']) {
      for (const s of await db.findAll(t)) {
        const k = parseInt(s.step_no, 10);
        if (/^\d+$/.test(String(s.step_no)) && k >= OB_EMP_NO) await db.update(t, String(s.id), { step_no: String(k + 1) });
      }
    }
    if (joinees.length) await db.batchInsert('HR_Onboarding_Steps', joinees.map(newRow));
    for (const j of joinees.filter(full)) { await db.update('HR_Onboarding', String(j.id), { locked: '1' }); await db.insert('HR_Onboarding_Audit', auditRow(j)); }
    await db.insert('App_State', { key_name: OB_SHIFT2_MARKER, value: joinees.length + ' entry shift', updated_at: now });
  }
  console.log('  \u2705 onboarding: Step 3 Employee Details -- ' + joinees.length + ' purani entry ke step shift');
}
// Har onboarding route se pehle (shift ho chuki ho)
async function obMw(req, res, next) {
  try { await obReady(); next(); }
  catch (e) { res.status(500).json({ error: 'Onboarding update nahi ho paya: ' + e.message }); }
}
// Entry (aur kind) ki files + unke tukde hatao. keep(x) true = wo file rehne do.
async function obDeleteFiles(jid, kind, keep) {
  let rows;
  if (db.pool) [rows] = await db.pool.query('SELECT id, kind, complete FROM `HR_Onboarding_Files` WHERE onboarding_id = ?', [String(jid)]);
  else rows = await db.findWhere('HR_Onboarding_Files', { onboarding_id: String(jid) });
  rows = rows.filter(x => (!kind || x.kind === kind) && !(keep && keep(x)));
  if (!rows.length) return 0;
  const ids = rows.map(x => String(x.id));
  if (db.pool) {
    await db.pool.query('DELETE FROM `HR_Onboarding_Chunks` WHERE file_id IN (?)', [ids]);
    await db.pool.query('DELETE FROM `HR_Onboarding_Files` WHERE id IN (?)', [ids]);
    db._invalidate('HR_Onboarding_Files'); db._invalidate('HR_Onboarding_Chunks');
  } else {
    const ch = (await db.findAll('HR_Onboarding_Chunks')).filter(c => ids.includes(String(c.file_id)));
    if (ch.length) await db.batchDeleteByIds('HR_Onboarding_Chunks', ch.map(c => c.id));
    await db.batchDeleteByIds('HR_Onboarding_Files', ids);
  }
  return rows.length;
}
// Ek tukda (base64) -- seq se
async function obChunk(fileId, seq) {
  if (db.pool) {
    const [r] = await db.pool.query('SELECT chunk_data FROM `HR_Onboarding_Chunks` WHERE file_id = ? AND seq = ? ORDER BY id DESC LIMIT 1', [String(fileId), String(seq)]);
    return r.length ? String(r[0].chunk_data || '') : '';
  }
  const c = (await db.findWhere('HR_Onboarding_Chunks', { file_id: String(fileId), seq: String(seq) })).pop();
  return c ? String(c.chunk_data || '') : '';
}

app.get('/api/onboarding', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid, canManage } = await obWho(req);
    const [joinees, steps, owners, users, files] = await Promise.all([
      db.findAll('HR_Onboarding'), db.findAll('HR_Onboarding_Steps'),
      db.findAll('HR_Onboarding_Owners'), db.findAll('Users'), obFileMeta()
    ]);
    const nameOf = id => (users.find(u => String(u.id) === String(id)) || {}).name || '';
    const today = obTodayIST();
    const byJ = {};
    steps.forEach(s => { const k = String(s.onboarding_id); (byJ[k] = byJ[k] || []).push(s); });
    // TAT (Step Admin): har step kitne din me -- location '' wali row me rakha jaata hai
    const tatMap = {};
    owners.forEach(o => {
      const d = parseInt(o.tat_days, 10);
      if (String(o.location || '') === '' && String(o.tat_days || '').trim() !== '' && Number.isInteger(d) && d >= 0) tatMap[String(o.step_no)] = d;
    });
    let list = joinees.map(j => {
      const rows = byJ[String(j.id)] || [];
      const st = OB_STEPS.map(def => {
        const r = rows.find(x => String(x.step_no) === String(def.no)) || {};
        return { no: def.no, doerId: r.doer_id ? String(r.doer_id) : '', manualDoer: r.doer_id ? '' : (r.doer_name || ''),
          doerName: r.doer_id ? nameOf(r.doer_id) : (r.doer_name || ''),
          done: String(r.done) === '1', na: String(r.na) === '1',
          doneAt: r.done_at || '', doneBy: r.done_by_name || '', note: r.note || '', plan: obPlan(def, j),
          checklist: obChecksOut(def, r.checklist) };
      });
      // TAT: jis step ka TAT set hai uski plan date = pichhla step jis din Done hua
      // (abhi Done nahi hua to uski plan date) + TAT din. Pehle step ke liye entry
      // banne ka din. TAT na ho to PDF wali timeline (joining se).
      let prevEnd = String(j.created_at || '').slice(0, 10);
      if (!isRealDate(prevEnd)) prevEnd = today;
      st.forEach(s => {
        const tat = tatMap[String(s.no)];
        s.tat = tat != null ? tat : null;
        if (s.na) return;
        // Day 0 = entry upload: na TAT, na joining-date wali plan to 0 din -- step jis din chalu ho usi din due
        if (tat != null) s.plan = obAddDays(prevEnd, tat);
        else if (!s.plan) s.plan = obAddDays(prevEnd, 0);
        const doneDay = String(s.doneAt || '').slice(0, 10);
        prevEnd = s.done && isRealDate(doneDay) ? doneDay : (s.plan || prevEnd);
      });
      // Sequential: pehla step jo na Done hai na N/A -- wahi "chalu" (current)
      const cur = st.find(s => !s.done && !s.na) || null;
      const rejected = (j.status || 'active') === 'rejected';
      st.forEach(s => {
        if (s.done) s.status = 'done';
        else if (s.na) s.status = 'na';
        else if (s === cur && rejected) s.status = 'rejected';
        else if (s === cur) s.status = !s.plan ? 'upcoming' : s.plan < today ? 'late' : s.plan === today ? 'today' : 'upcoming';
        else s.status = 'waiting';
        s.current = s === cur;
      });
      const counted = st.filter(s => !s.na);
      const diRow = rows.find(x => String(x.step_no) === String(OB_DI_NO));
      const ivRow = rows.find(x => String(x.step_no) === String(OB_IV_NO));
      const empRow = rows.find(x => String(x.step_no) === String(OB_EMP_NO));
      // Resume / portfolio / video: Admin-HR, aur Step 1 / Director Review / Step 3 ke doer ko
      const seeDocs = canManage || [diRow, ivRow, empRow].some(r => r && String(r.doer_id || '') === uid);
      const docs = {};
      Object.keys(OB_FILE_KINDS).forEach(k => {
        const fl = files.find(x => String(x.onboarding_id) === String(j.id) && x.kind === k);
        docs[k] = seeDocs ? { link: j[k + '_link'] || '', file: fl ? { name: fl.file_name || '', type: fl.mime_type || '', size: parseInt(fl.file_size, 10) || 0, at: fl.created_at || '' } : null } : null;
      });
      return {
        id: String(j.id), name: j.name || '', designation: j.designation || '',
        phone: j.phone || '', email: j.email || '', refBy: j.ref_by || '', docs, interview: obInterview(j, ivRow),
        locked: false, lockNote: '', docsCollected: j.docs_collected || '',
        altPhone: j.alt_phone || '', altPhoneNA: String(j.alt_phone_na) === '1',
        salary: canManage ? (j.salary || '') : '', location: j.location || '', dob: j.dob || '',
        joiningDate: j.joining_date || '', esis: j.esis || '', contract: j.contract || '',
        isSales: String(j.is_sales || '').toLowerCase() === 'yes',
        probationDays: parseInt(j.probation_days, 10) || 90, status: j.status || 'active',
        notes: canManage ? (j.notes || '') : '', createdBy: j.created_by_name || '', createdAt: j.created_at || '',
        currentNo: cur ? cur.no : 0, steps: st,
        progress: { done: counted.filter(s => s.done).length, total: counted.length, late: cur && cur.status === 'late' ? 1 : 0 }
      };
    });
    // Doer ko sirf woh joinee jinme uska koi step hai -- aur sirf apne step
    // (saath me "abhi kaunsa step chal raha hai" taaki pata rahe kab uski baari)
    if (!canManage) {
      list = list.filter(j => j.status !== 'cancelled' && j.status !== 'rejected' && j.steps.some(s => s.doerId === uid)).map(j => {
        const cur = j.steps.find(s => s.current);
        return Object.assign({}, j, {
          currentDoer: cur ? cur.doerName : '',
          steps: j.steps.filter(s => s.doerId === uid)
        });
      });
    }
    list.sort((a, b) => String(a.joiningDate).localeCompare(String(b.joiningDate)) || String(a.id).localeCompare(String(b.id)));
    const ownerMap = {};
    owners.forEach(o => {
      const k = String(o.step_no) + '|' + String(o.location || '');
      if (o.doer_id) ownerMap[k] = { id: String(o.doer_id), name: nameOf(o.doer_id) };
      else if (o.doer_name) ownerMap[k] = { id: '', name: o.doer_name, manual: true };
    });
    const uniq = arr => [...new Set(arr.map(x => String(x || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const isAdmin = req.session.role === 'admin';
    const unlockers = await obUnlockers();
    res.json({
      canManage, me: { id: uid, name: (me && me.name) || '' }, today,
      isAdmin, canUnlock: isAdmin || unlockers.includes(uid), unlockers: isAdmin ? unlockers : [],
      phases: OB_PHASES, steps: OB_STEPS, locations: OB_LOCATIONS, control: OB_CONTROL,
      owners: canManage ? ownerMap : {},
      tat: tatMap,
      users: canManage ? users.map(u => ({ id: String(u.id), name: u.name || '', department: u.department || '' }))
        .sort((a, b) => a.name.localeCompare(b.name)) : [],
      designations: canManage ? uniq(joinees.map(j => j.designation)) : [],
      refs: canManage ? uniq(joinees.map(j => j.ref_by)) : [],
      places: canManage ? uniq(OB_LOCATIONS.concat(joinees.map(j => j.location))) : OB_LOCATIONS,
      joinees: list
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/onboarding', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid, canManage } = await obWho(req);
    if (!canManage) return res.status(403).json({ error: 'Sirf Admin / HR naya employee jod sakte hain' });
    // Entry = Step 1 (Initial Candidate Details) -- baaki details Step 3 me
    const f = obClean(obPick(req.body || {}, OB_STEP1_KEYS));
    const bad = obCheck(f);
    if (bad) return res.status(400).json({ error: bad });
    const now = obNowIST();
    const j = await db.insert('HR_Onboarding', Object.assign({}, f, {
      status: 'active', interview: '', locked: '0', lock_note: '', created_by: uid, created_by_name: (me && me.name) || '', created_at: now, updated_at: now
    }));
    const owners = await db.findAll('HR_Onboarding_Owners');
    const rows = OB_STEPS.map(def => {
      const o = obOwnerFor(owners, def.no, def.byLocation ? f.location : '');
      // Step 1 entry ke saath hi complete -> details seedha Director (Step 2) ke paas
      const s1 = !!def.dataInputs;
      return {
        onboarding_id: String(j.id), step_no: String(def.no), doer_id: o.doer_id, doer_name: o.doer_name,
        done: s1 ? '1' : '0', done_at: s1 ? now : '', done_by: s1 ? uid : '', done_by_name: s1 ? ((me && me.name) || '') : '', note: s1 ? 'Entry form se' : '',
        na: obApplies(def, f) ? '0' : '1', updated_at: now
      };
    });
    await db.batchInsert('HR_Onboarding_Steps', rows);
    await obAudit(j.id, 'create', 'Entry bani (Step 1): ' + f.name + ', ' + f.designation + ', ' + f.phone, me, uid);
    const draft = String((req.body || {}).draft || '');
    if (OB_DRAFT_RE.test(draft)) await obAdoptDraft(draft, j.id, me, uid);
    res.json({ success: true, id: String(j.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/onboarding/:id', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid, canManage } = await obWho(req);
    if (!canManage) return res.status(403).json({ error: 'Not allowed' });
    const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
    if (!j) return res.status(404).json({ error: 'Employee nahi mila' });
    const b = req.body || {};
    const now = obNowIST();
    const upd = { updated_at: now };
    let reopen = false;
    if (b.status != null) {
      if (!['active', 'cancelled'].includes(String(b.status))) return res.status(400).json({ error: 'Galat status' });
      upd.status = String(b.status);
      // Rejected candidate ko phir chalu kiya -> Interview (Step 2) wapas pending
      if (upd.status === 'active' && j.status === 'rejected') { upd.interview = ''; reopen = true; }
    }
    let f = null;
    const empEdit = OB_EMP_KEYS.some(k => b[k] != null);
    if (OB_STEP1_KEYS.some(k => b[k] != null) || empEdit) {
      if (obLocked(j)) return res.status(403).json({ error: OB_LOCK_MSG });
      f = obClean(obPick(b, OB_STEP1_KEYS.concat(OB_EMP_KEYS)), j);
      const bad = obCheck(f) || (empEdit ? obCheckEmp(f) : '');
      if (bad) return res.status(400).json({ error: bad });
      Object.assign(upd, f);
    }
    await db.update('HR_Onboarding', String(j.id), upd);
    if (f) { const d = obDiff(j, f); if (d) await obAudit(j.id, 'edit', d, me, uid); }
    if (upd.status) await obAudit(j.id, 'status', upd.status === 'cancelled' ? 'Onboarding cancel' : (reopen ? 'Rejected candidate phir chalu (Director Review wapas pending)' : 'Onboarding phir chalu'), me, uid);
    if (reopen) {
      const iv = (await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(j.id), step_no: String(OB_IV_NO) }))[0];
      if (iv && String(iv.done) !== '1') await db.update('HR_Onboarding_Steps', String(iv.id), { done_at: '', done_by: '', done_by_name: '', note: '', updated_at: now });
    }
    if (f) await obSyncSteps(j, f, now);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/onboarding/:id', requireAuth, obMw, async (req, res) => {
  try {
    const { canManage } = await obWho(req);
    if (!canManage) return res.status(403).json({ error: 'Not allowed' });
    const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
    if (!j) return res.status(404).json({ error: 'Employee nahi mila' });
    const steps = await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(j.id) });
    if (steps.length) await db.batchDeleteByIds('HR_Onboarding_Steps', steps.map(s => s.id));
    await obDeleteFiles(j.id);
    const au = await db.findWhere('HR_Onboarding_Audit', { onboarding_id: String(j.id) });
    if (au.length) await db.batchDeleteByIds('HR_Onboarding_Audit', au.map(a => a.id));
    await db.delete('HR_Onboarding', String(j.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/onboarding/:id/steps/:no', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid, canManage } = await obWho(req);
    const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
    if (!j) return res.status(404).json({ error: 'Employee nahi mila' });
    const def = OB_STEPS.find(d => String(d.no) === String(req.params.no));
    if (!def) return res.status(404).json({ error: 'Step nahi mila' });
    const all = await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(j.id) });
    let row = all.find(s => String(s.step_no) === String(def.no));
    if (!row) {
      if (!canManage) return res.status(403).json({ error: 'Not allowed' });
      row = await db.insert('HR_Onboarding_Steps', { onboarding_id: String(j.id), step_no: String(def.no), doer_id: '', doer_name: '', done: '0', na: obApplies(def, j) ? '0' : '1', note: '', updated_at: obNowIST() });
      all.push(row);
    }
    // Abhi kaunsa step chalu hai (sequential)
    const byNo = n => all.find(s => String(s.step_no) === String(n));
    const curDef = OB_STEPS.find(d => { const s = byNo(d.no); return !s || (String(s.done) !== '1' && String(s.na) !== '1'); });
    const b = req.body || {};
    const now = obNowIST();
    const upd = { updated_at: now };
    if (b.doerId !== undefined || b.doerName !== undefined) {
      if (!canManage) return res.status(403).json({ error: 'Doer sirf Admin / HR badal sakte hain' });
      const did = String(b.doerId || '').trim();
      const dname = String(b.doerName || '').trim().slice(0, 100);
      if (did && !(await db.findOne('Users', { id: did }))) return res.status(400).json({ error: 'Ye user nahi mila' });
      upd.doer_id = did;
      upd.doer_name = did ? '' : dname;
    }
    let action = String(b.action || '');
    // Interview with Director: Done = Selected
    if (def.interview && action === 'done') action = 'selected';
    if (action === 'selected' && !def.interview) action = 'done';
    let jUpd = null, diData = null, empData = null, tick = null;
    if (action === 'done' || action === 'selected' || action === 'rejected') {
      if (action === 'rejected' && !def.interview) return res.status(400).json({ error: 'Reject sirf Interview step par hota hai' });
      if (!canManage && String(row.doer_id) !== uid) return res.status(403).json({ error: 'Ye step aapka nahi hai' });
      if ((j.status || 'active') === 'cancelled') return res.status(400).json({ error: 'Ye onboarding cancel ho chuki hai' });
      if ((j.status || 'active') === 'rejected') return res.status(400).json({ error: 'Ye candidate Rejected hai' });
      if (String(row.na) === '1') return res.status(400).json({ error: 'Ye step is employee par lagu nahi (N/A)' });
      if (String(row.done) === '1') return res.status(400).json({ error: 'Ye step pehle hi Done hai' });
      if (!curDef || curDef.no !== def.no) {
        return res.status(400).json({ error: 'Pehle Step ' + (curDef ? curDef.no + ' (' + curDef.title + ')' : '') + ' Done hona chahiye' });
      }
      // Checklist wale step: saare points tick hone par hi Done
      if (def.checklist && action === 'done') {
        const cl = obParseChecks(row.checklist);
        const miss = def.checklist.filter(c => !cl[c.id]);
        if (miss.length) return res.status(400).json({ error: 'Pehle checklist ke saare points tick karo (' + miss.length + ' baaki)' });
      }
      // Step 1: Done ke saath candidate ki details (purani entry jiska Step 1 baaki tha)
      if (def.dataInputs) {
        const f = obClean(obPick(b, OB_STEP1_KEYS), j);
        const bad = obCheck(f);
        if (bad) return res.status(400).json({ error: bad });
        diData = { name: f.name, designation: f.designation, phone: f.phone, alt_phone: f.alt_phone, alt_phone_na: f.alt_phone_na, is_sales: f.is_sales,
          resume_link: f.resume_link, portfolio_link: f.portfolio_link, video_link: f.video_link, updated_at: now };
      }
      // Step 3: Remaining Employee Details -- Done ke saath (Step 1 ki details bhi yahin edit; lock nahi)
      if (def.empDetails) {
        const f = obClean(obPick(b, OB_STEP1_KEYS.concat(OB_EMP_KEYS)), j);
        const bad = obCheck(f) || obCheckEmp(f) || (!f.docs_collected ? 'Documents collected? -- Yes / No chuno' : '');
        if (bad) return res.status(400).json({ error: bad });
        empData = { name: f.name, designation: f.designation, phone: f.phone, alt_phone: f.alt_phone, alt_phone_na: f.alt_phone_na, is_sales: f.is_sales,
          resume_link: f.resume_link, portfolio_link: f.portfolio_link, video_link: f.video_link,
          email: f.email, location: f.location, dob: f.dob, esis: f.esis, contract: f.contract, docs_collected: f.docs_collected, probation_days: f.probation_days,
          ref_by: f.ref_by, notes: f.notes, locked: '0', lock_note: '', updated_at: now };
      }
      const note = String(b.note || '').trim().slice(0, 1000);
      if (action === 'rejected') {
        // Step Done nahi hota -- entry "rejected", flow yahin rukta hai
        Object.assign(upd, { done_at: now, done_by: uid, done_by_name: (me && me.name) || '', note });
        jUpd = { status: 'rejected', interview: 'rejected', updated_at: now };
      } else {
        Object.assign(upd, { done: '1', done_at: now, done_by: uid, done_by_name: (me && me.name) || '', note });
        if (def.interview) jUpd = { interview: 'selected', updated_at: now };
      }
    } else if (action === 'tick') {
      const item = (def.checklist || []).find(c => c.id === String(b.item || ''));
      if (!item) return res.status(400).json({ error: 'Is step me ye checklist point nahi hai' });
      if (!canManage && String(row.doer_id) !== uid) return res.status(403).json({ error: 'Ye step aapka nahi hai' });
      if ((j.status || 'active') !== 'active') return res.status(400).json({ error: 'Ye onboarding chalu nahi hai' });
      if (String(row.na) === '1') return res.status(400).json({ error: 'Ye step is employee par lagu nahi (N/A)' });
      if (String(row.done) === '1') return res.status(400).json({ error: 'Ye step pehle hi Done hai' });
      if (!curDef || curDef.no !== def.no) return res.status(400).json({ error: 'Pehle Step ' + (curDef ? curDef.no + ' (' + curDef.title + ')' : '') + ' Done hona chahiye' });
      const cl = obParseChecks(row.checklist);
      const on = !(b.checked === false || String(b.checked) === 'false' || String(b.checked) === '0');
      if (on) cl[item.id] = { at: now, by: uid, byName: (me && me.name) || '' }; else delete cl[item.id];
      upd.checklist = JSON.stringify(cl);
      tick = { item, on };
    } else if (action === 'undo') {
      if (!canManage) return res.status(403).json({ error: 'Not allowed' });
      if (String(row.done) !== '1') return res.status(400).json({ error: 'Ye step Done hi nahi hai' });
      // Sirf aakhri Done step hi Undo -- warna aage ke Done step bina pichhle ke reh jaate
      const later = all.some(s => parseInt(s.step_no, 10) > def.no && String(s.done) === '1');
      if (later) return res.status(400).json({ error: 'Pehle aage wale step Undo karo (aakhri Done step se shuru)' });
      Object.assign(upd, { done: '0', done_at: '', done_by: '', done_by_name: '', note: '', checklist: '' });
      if (def.interview) jUpd = { interview: '', updated_at: now };
      if (def.empDetails) jUpd = { locked: '0', lock_note: '', updated_at: now };     // Step 3 wapas = lock hata
    } else if (action === 'na' || action === 'applicable') {
      if (!canManage) return res.status(403).json({ error: 'Not allowed' });
      if (String(row.done) === '1') return res.status(400).json({ error: 'Pehle Undo karo' });
      upd.na = action === 'na' ? '1' : '0';
    } else if (action) {
      return res.status(400).json({ error: 'Galat action' });
    }
    if (Object.keys(upd).length === 1) return res.status(400).json({ error: 'Kuch badla nahi' });
    await db.update('HR_Onboarding_Steps', String(row.id), upd);
    if (jUpd) await db.update('HR_Onboarding', String(j.id), jUpd);
    if (diData) {
      await db.update('HR_Onboarding', String(j.id), diData);
      await obSyncSteps(j, Object.assign({}, j, diData), now);
      const d = obDiff(j, diData); if (d) await obAudit(j.id, 'edit', 'Step 1: ' + d, me, uid);
    }
    if (empData) {
      await db.update('HR_Onboarding', String(j.id), empData);
      await obSyncSteps(j, Object.assign({}, j, empData), now);
      await obAudit(j.id, 'details', 'Step 3: ' + (obDiff(j, empData) || 'details bhari'), me, uid);
    }
    // History: step ke kaam (doer badalna nahi)
    if (tick) await obAudit(j.id, 'check', 'Step ' + def.no + ' (' + def.title + '): ' + (tick.on ? 'ticked' : 'unticked') + ' - ' + tick.item.label, me, uid);
    if (action && action !== 'tick') {
      const what = action === 'selected' ? 'Approved' : action === 'rejected' ? 'Rejected' : action === 'done' ? 'Done'
        : action === 'undo' ? 'Undo' : action === 'na' ? 'N/A' : 'Lagu (applicable)';
      const rem = String(b.note || '').trim();
      await obAudit(j.id, action === 'selected' ? 'approve' : action === 'rejected' ? 'reject' : 'step',
        'Step ' + def.no + ' (' + def.title + '): ' + what + (rem ? ' -- ' + rem.slice(0, 300) : '') + (action === 'undo' && def.empDetails ? ' -- lock hata' : ''), me, uid);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Candidate ki file (resume / portfolio / intro video) -- ek kind ki ek file, nayi
// poori aate hi purani hat jaati hai. Admin / HR ya Step 1 (Data Inputs) ka doer.
// Tukdon me: start (naam, size) -> chunk (seq 0, 1, ...) -> finish.
// Nayi entry ke form me file entry banne se pehle hi upload hoti hai -- 'd' + random token ke naam se rakhi jaati hai,
// entry ban-ne par us entry ko de di jaati hai (obAdoptDraft); Cancel par hat jaati hai
const OB_DRAFT_RE = /^d[a-z0-9]{8,14}$/;
async function obFileReq(req, res, nos) {
  if (OB_DRAFT_RE.test(String(req.params.id))) {
    const w = await obWho(req);
    if (!w.canManage) { res.status(403).json({ error: 'Not allowed' }); return null; }
    return { uid: w.uid, j: { id: String(req.params.id) }, draft: true };
  }
  const { uid, canManage } = await obWho(req);
  const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
  if (!j) { res.status(404).json({ error: 'Employee nahi mila' }); return null; }
  if (!canManage && !(await obIsDoer(j.id, uid, nos))) { res.status(403).json({ error: 'Not allowed' }); return null; }
  return { uid, j };
}
// Upload chal rahi file ka row (isi entry ka, abhi adhoora)
async function obUploadRow(j, fid) {
  const f = (await obFileMetaAll(j.id)).find(x => String(x.id) === String(fid));
  return f && String(f.complete) === '0' ? f : null;
}
async function obFileMetaAll(jid) {
  if (db.pool) {
    const [r] = await db.pool.query('SELECT id, kind, file_size, complete FROM `HR_Onboarding_Files` WHERE onboarding_id = ?', [String(jid)]);
    return r;
  }
  return db.findWhere('HR_Onboarding_Files', { onboarding_id: String(jid) });
}
// Entry ban gayi -- draft ki poori hui files ab us entry ki
async function obAdoptDraft(token, jid, me, uid) {
  try {
    await obDeleteFiles(token, null, x => String(x.complete) !== '0');      // adhoori upload hatao
    const files = await obFileMeta(token);
    if (!files.length) return;
    if (db.pool) { await db.pool.query('UPDATE `HR_Onboarding_Files` SET onboarding_id = ? WHERE onboarding_id = ?', [String(jid), token]); db._invalidate('HR_Onboarding_Files'); }
    else for (const f of files) await db.update('HR_Onboarding_Files', String(f.id), { onboarding_id: String(jid) });
    for (const f of files) await obAudit(jid, 'file', OB_FILE_KINDS[f.kind].label + ' upload: ' + (f.file_name || '') + ' (' + Math.round((parseInt(f.file_size, 10) || 0) / 1024) + ' KB)', me, uid);
  } catch (e) { console.error('  onboarding draft adopt:', e.message); }
}
// Chhodi hui (24 ghante se purani) draft files saaf -- ghante me ek baar se zyada nahi
let _obDraftSweep = 0;
async function obSweepDrafts() {
  if (Date.now() - _obDraftSweep < 3600000) return;
  _obDraftSweep = Date.now();
  try {
    const cutoff = new Date(Date.now() + 330 * 60000 - 24 * 3600000).toISOString().replace('T', ' ').split('.')[0];
    let ids;
    if (db.pool) { const [r] = await db.pool.query("SELECT DISTINCT onboarding_id AS id FROM `HR_Onboarding_Files` WHERE onboarding_id LIKE 'd%' AND created_at < ?", [cutoff]); ids = r.map(x => String(x.id)); }
    else ids = [...new Set((await db.findAll('HR_Onboarding_Files')).filter(x => OB_DRAFT_RE.test(String(x.onboarding_id)) && String(x.created_at) < cutoff).map(x => String(x.onboarding_id)))];
    for (const id of ids) if (OB_DRAFT_RE.test(id)) await obDeleteFiles(id);
  } catch (e) { console.error('  onboarding draft sweep:', e.message); }
}
// Nayi entry ka form Cancel hua -- draft ki files hatao
app.delete('/api/onboarding-draft/:token', requireAuth, obMw, async (req, res) => {
  try {
    const { canManage } = await obWho(req);
    if (!canManage) return res.status(403).json({ error: 'Not allowed' });
    if (!OB_DRAFT_RE.test(String(req.params.token))) return res.status(400).json({ error: 'Galat draft' });
    res.json({ success: true, deleted: await obDeleteFiles(String(req.params.token)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/files/start', requireAuth, obMw, async (req, res) => {
  try {
    const ctx = await obFileReq(req, res, [OB_DI_NO, OB_EMP_NO]);
    if (!ctx) return;
    if (obLocked(ctx.j)) return res.status(403).json({ error: OB_LOCK_MSG });
    const { kind, fileName, mimeType, size } = req.body || {};
    const name = String(fileName || 'file').slice(0, 200);
    const mime = String(mimeType || '').slice(0, 120);
    if (ctx.draft) obSweepDrafts();
    const bad = obFileTypeBad(kind, name, mime);
    if (bad) return res.status(400).json({ error: bad });
    const bytes = parseInt(size, 10);
    if (!(bytes > 0)) return res.status(400).json({ error: 'File khali hai' });
    if (bytes > OB_FILE_MAX_MB * 1024 * 1024) return res.status(400).json({ error: OB_FILE_KINDS[kind].label + ' ' + OB_FILE_MAX_MB + ' MB se badi hai -- link daal do' });
    // Pichhli beech me chhodi upload saaf
    await obDeleteFiles(ctx.j.id, kind, x => String(x.complete) !== '0');
    const row = await db.insert('HR_Onboarding_Files', {
      onboarding_id: String(ctx.j.id), kind, file_name: name, mime_type: mime, file_size: String(bytes),
      file_data: '', complete: '0', chunks: '0', uploaded_by: ctx.uid, created_at: obNowIST()
    });
    res.json({ success: true, fileId: String(row.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/files/:fid/chunk', requireAuth, obMw, async (req, res) => {
  try {
    const ctx = await obFileReq(req, res, [OB_DI_NO, OB_EMP_NO]);
    if (!ctx) return;
    if (!(await obUploadRow(ctx.j, req.params.fid))) return res.status(404).json({ error: 'Upload nahi mili -- dobara try karo' });
    const seq = parseInt((req.body || {}).seq, 10);
    const data = String((req.body || {}).data || '');
    if (!(seq >= 0 && seq < 100000)) return res.status(400).json({ error: 'Galat tukda' });
    if (!data || data.length > OB_CHUNK_B64_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return res.status(400).json({ error: 'Tukda kharab hai' });
    const fid = String(req.params.fid);
    // Retry me wahi tukda dobara aaye to purana hatao
    if (db.pool) await db.pool.query('DELETE FROM `HR_Onboarding_Chunks` WHERE file_id = ? AND seq = ?', [fid, String(seq)]);
    else { const old = await db.findWhere('HR_Onboarding_Chunks', { file_id: fid, seq: String(seq) }); if (old.length) await db.batchDeleteByIds('HR_Onboarding_Chunks', old.map(c => c.id)); }
    await db.insert('HR_Onboarding_Chunks', { file_id: fid, seq: String(seq), chunk_data: data });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Upload beech me Cancel -- sirf wahi adhoori file + uske tukde hatao; pehle se saved file waisi hi rehti hai
app.post('/api/onboarding/:id/files/:fid/cancel', requireAuth, obMw, async (req, res) => {
  try {
    const ctx = await obFileReq(req, res, [OB_DI_NO, OB_EMP_NO]);
    if (!ctx) return;
    const f = await obUploadRow(ctx.j, req.params.fid);
    if (!f) return res.json({ success: true, deleted: 0 });
    const fid = String(f.id);
    res.json({ success: true, deleted: await obDeleteFiles(ctx.j.id, null, x => String(x.id) !== fid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/files/:fid/finish', requireAuth, obMw, async (req, res) => {
  try {
    const ctx = await obFileReq(req, res, [OB_DI_NO, OB_EMP_NO]);
    if (!ctx) return;
    const f = await obUploadRow(ctx.j, req.params.fid);
    if (!f) return res.status(404).json({ error: 'Upload nahi mili -- dobara try karo' });
    const fid = String(f.id);
    let parts;
    if (db.pool) [parts] = await db.pool.query('SELECT seq, LENGTH(chunk_data) AS len FROM `HR_Onboarding_Chunks` WHERE file_id = ?', [fid]);
    else parts = (await db.findWhere('HR_Onboarding_Chunks', { file_id: fid })).map(c => ({ seq: c.seq, len: String(c.chunk_data || '').length }));
    const seqs = new Set(parts.map(p => parseInt(p.seq, 10)));
    const count = seqs.size;
    let ok = count > 0;
    for (let i = 0; i < count; i++) if (!seqs.has(i)) ok = false;
    // base64 -> bytes (har tukde me 2 tak padding)
    const approx = parts.reduce((t, p) => t + Math.floor((parseInt(p.len, 10) || 0) * 3 / 4), 0);
    if (!ok || Math.abs(approx - (parseInt(f.file_size, 10) || 0)) > 2 * count + 2) {
      return res.status(400).json({ error: 'File poori nahi pahunchi -- dobara upload karo' });
    }
    if (db.pool) await db.pool.query("UPDATE `HR_Onboarding_Files` SET complete = '1', chunks = ? WHERE id = ?", [String(count), fid]);
    else await db.update('HR_Onboarding_Files', fid, { complete: '1', chunks: String(count) });
    db._invalidate && db._invalidate('HR_Onboarding_Files');
    // Isi kind ki purani file hatao
    await obDeleteFiles(ctx.j.id, f.kind, x => String(x.id) === fid);
    const w = await obWho(req);
    const nm = (await obFileMeta(ctx.j.id)).find(x => String(x.id) === fid);
    if (!ctx.draft) await obAudit(ctx.j.id, 'file', OB_FILE_KINDS[f.kind].label + ' upload: ' + ((nm && nm.file_name) || '') + ' (' + Math.round((parseInt(f.file_size, 10) || 0) / 1024) + ' KB)', w.me, w.uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// File kholna: Admin / HR, ya Data Inputs / Interview ka doer. Seedha file (binary)
// bhejte hain -- tukde ek-ek karke, taaki badi file se server ki memory na bhare.
app.get('/api/onboarding/:id/files/:kind', requireAuth, obMw, async (req, res) => {
  try {
    const ctx = await obFileReq(req, res, [OB_DI_NO, OB_IV_NO, OB_EMP_NO]);
    if (!ctx) return;
    const meta = (await obFileMeta(ctx.j.id)).filter(x => x.kind === String(req.params.kind))
      .sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0))[0];
    if (!meta) return res.status(404).json({ error: 'File nahi mili' });
    let row;
    if (db.pool) { const [r] = await db.pool.query('SELECT file_data, chunks FROM `HR_Onboarding_Files` WHERE id = ?', [String(meta.id)]); row = r[0]; }
    else row = await db.findOne('HR_Onboarding_Files', { id: String(meta.id) });
    const chunks = parseInt((row || {}).chunks, 10) || 0;
    const legacy = String((row || {}).file_data || '');
    if (!chunks && !legacy) return res.status(404).json({ error: 'File nahi mili' });
    res.setHeader('Content-Type', meta.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(meta.file_name || 'file'));
    res.setHeader('Cache-Control', 'private, no-store');
    if (!chunks) return res.end(Buffer.from(legacy.slice(legacy.indexOf(',') + 1), 'base64'));   // purani chhoti file
    for (let i = 0; i < chunks; i++) {
      const part = await obChunk(meta.id, i);
      if (!res.write(Buffer.from(part, 'base64'))) await new Promise(r => res.once('drain', r));
    }
    res.end();
  } catch (err) {
    if (res.headersSent) res.end(); else res.status(500).json({ error: err.message });
  }
});
app.delete('/api/onboarding/:id/files/:kind', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid, canManage } = await obWho(req);
    if (!canManage && !(await obIsDoer(req.params.id, uid, [OB_DI_NO, OB_EMP_NO]))) return res.status(403).json({ error: 'Not allowed' });
    if (!OB_FILE_KINDS[req.params.kind]) return res.status(400).json({ error: 'File type galat hai' });
    const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
    if (j && obLocked(j)) return res.status(403).json({ error: OB_LOCK_MSG });
    const gone = await obDeleteFiles(String(req.params.id), String(req.params.kind));
    if (gone && !OB_DRAFT_RE.test(String(req.params.id))) await obAudit(req.params.id, 'file', OB_FILE_KINDS[req.params.kind].label + ' file hatai', me, uid);
    res.json({ success: true, deleted: gone });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unlock (wajah zaroori) -- Admin ya ijazat wala user. Lock -- Admin / HR / ijazat wala,
// sirf jab Step 3 complete ho.
app.post('/api/onboarding/:id/unlock', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid } = await obWho(req);
    if (!(await obCanUnlock(req))) return res.status(403).json({ error: 'Unlock sirf Admin ya ijazat wale user kar sakte hain' });
    const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
    if (!j) return res.status(404).json({ error: 'Employee nahi mila' });
    if (!obLocked(j)) return res.status(400).json({ error: 'Ye pehle se unlocked hai' });
    const reason = String((req.body || {}).reason || '').trim().slice(0, 250);
    if (reason.length < 3) return res.status(400).json({ error: 'Unlock ki wajah likho' });
    const by = (me && me.name) || '';
    await db.update('HR_Onboarding', String(j.id), { locked: '0', lock_note: ('Unlocked by ' + by + ': ' + reason).slice(0, 300), updated_at: obNowIST() });
    await obAudit(j.id, 'unlock', 'Unlock -- ' + reason, me, uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/onboarding/:id/lock', requireAuth, obMw, async (req, res) => {
  try {
    const { me, uid, canManage } = await obWho(req);
    if (!canManage && !(await obCanUnlock(req))) return res.status(403).json({ error: 'Not allowed' });
    const j = await db.findOne('HR_Onboarding', { id: String(req.params.id) });
    if (!j) return res.status(404).json({ error: 'Employee nahi mila' });
    if (obLocked(j)) return res.status(400).json({ error: 'Ye pehle se locked hai' });
    const s3 = (await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(j.id), step_no: String(OB_EMP_NO) }))[0];
    if (!s3 || String(s3.done) !== '1') return res.status(400).json({ error: 'Step 3 complete hone ke baad hi lock hota hai' });
    await db.update('HR_Onboarding', String(j.id), { locked: '1', lock_note: '', updated_at: obNowIST() });
    await obAudit(j.id, 'lock', 'Phir se lock', me, uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/onboarding/:id/history', requireAuth, obMw, async (req, res) => {
  try {
    const { canManage } = await obWho(req);
    if (!canManage && !(await obCanUnlock(req))) return res.status(403).json({ error: 'Not allowed' });
    const rows = await db.findWhere('HR_Onboarding_Audit', { onboarding_id: String(req.params.id) });
    rows.sort((a, b) => (parseInt(b.id, 10) || 0) - (parseInt(a.id, 10) || 0));
    res.json({ history: rows.map(r => ({ action: r.action || '', details: r.details || '', by: r.by_name || '', at: r.created_at || '' })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Unlock ki ijazat kise -- sirf Admin badal sakta hai (Step Admin me)
app.put('/api/onboarding-unlockers', requireAuth, obMw, async (req, res) => {
  try {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Sirf Admin' });
    const { me, uid } = await obWho(req);
    const ids = [...new Set((Array.isArray((req.body || {}).ids) ? req.body.ids : []).map(String).filter(Boolean))].slice(0, 100);
    const users = await db.findAll('Users');
    const bad = ids.find(x => !users.some(u => String(u.id) === x));
    if (bad) return res.status(400).json({ error: 'Ye user nahi mila' });
    await ensureAppStateTab(db);
    const ex = (await db.findWhere('App_State', { key_name: OB_UNLOCK_KEY }))[0];
    const now = obNowIST();
    if (ex) await db.update('App_State', String(ex.id), { value: JSON.stringify(ids), updated_at: now });
    else await db.insert('App_State', { key_name: OB_UNLOCK_KEY, value: JSON.stringify(ids), updated_at: now });
    console.log('  onboarding unlockers by ' + ((me && me.name) || uid) + ': ' + ids.join(','));
    res.json({ success: true, count: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Workflow tab: har step ka default doer. Naye employee me apne aap lagta hai,
// aur chalu entries ke jin pending step me doer khali hai unme bhi bhar deta hai.
app.put('/api/onboarding-owners', requireAuth, obMw, async (req, res) => {
  try {
    const { canManage } = await obWho(req);
    if (!canManage) return res.status(403).json({ error: 'Not allowed' });
    const list = Array.isArray((req.body || {}).owners) ? req.body.owners : [];
    // Step Admin se: applyAll = chalu entries ke jo step abhi Done nahi hue unpar bhi
    // naya doer laga do (warna sirf khali step bharte hain)
    const applyAll = (req.body || {}).applyAll === true;
    const tats = Array.isArray((req.body || {}).tats) ? req.body.tats : [];
    if (!list.length && !tats.length) return res.status(400).json({ error: 'Kuch nahi bheja' });
    // TAT pehle jaancho -- galat ho to kuch bhi save na ho
    const tatClean = [];
    for (const t of tats) {
      const def = OB_STEPS.find(d => String(d.no) === String(t.step));
      if (!def) continue;
      const raw = String(t.days == null ? '' : t.days).trim();
      const days = raw === '' ? '' : Number(raw);
      if (days !== '' && !(Number.isInteger(days) && days >= 0 && days <= 365)) {
        return res.status(400).json({ error: 'Step ' + def.no + ': TAT 0 se 365 din ke beech poora number daalo' });
      }
      tatClean.push({ no: def.no, days: days === '' ? '' : String(days) });
    }
    const now = obNowIST();
    const owners = await db.findAll('HR_Onboarding_Owners');
    let filled = 0;
    for (const o of list) {
      const def = OB_STEPS.find(d => String(d.no) === String(o.step));
      if (!def) continue;
      const loc = def.byLocation ? String(o.location || 'Delhi').trim().slice(0, 60) : '';
      const did = String(o.doerId || '').trim();
      const dname = did ? '' : String(o.doerName || '').trim().slice(0, 100);
      if (did && !(await db.findOne('Users', { id: did }))) return res.status(400).json({ error: 'Ye user nahi mila' });
      const ex = owners.find(x => String(x.step_no) === String(def.no) && String(x.location || '') === loc);
      if (ex) await db.update('HR_Onboarding_Owners', String(ex.id), { doer_id: did, doer_name: dname, updated_at: now });
      else await db.insert('HR_Onboarding_Owners', { step_no: String(def.no), location: loc, doer_id: did, doer_name: dname, updated_at: now });
      if (!did && !dname) continue;
      // Chalu entries: is step me doer khali ho to bhar do (chuna hua doer nahi badalta).
      // applyAll ho to jo step abhi Done nahi hua usme bhi naya doer.
      const joinees = (await db.findAll('HR_Onboarding')).filter(j => !['cancelled', 'rejected'].includes(j.status || 'active') && (!loc || j.location === loc));
      for (const j of joinees) {
        const s = (await db.findWhere('HR_Onboarding_Steps', { onboarding_id: String(j.id), step_no: String(def.no) }))[0];
        const khali = s && !s.doer_id && !s.doer_name;
        const alag = s && (String(s.doer_id || '') !== did || String(s.doer_name || '') !== dname);
        if (s && (khali || (applyAll && alag)) && String(s.done) !== '1' && String(s.na) !== '1') {
          await db.update('HR_Onboarding_Steps', String(s.id), { doer_id: did, doer_name: dname, updated_at: now });
          filled++;
        }
      }
    }
    // TAT save -- step ki location '' wali row me
    if (tatClean.length) {
      const fresh = await db.findAll('HR_Onboarding_Owners');
      for (const t of tatClean) {
        const ex = fresh.find(x => String(x.step_no) === String(t.no) && String(x.location || '') === '');
        if (ex) await db.update('HR_Onboarding_Owners', String(ex.id), { tat_days: t.days, updated_at: now });
        else await db.insert('HR_Onboarding_Owners', { step_no: String(t.no), location: '', doer_id: '', doer_name: '', tat_days: t.days, updated_at: now });
      }
    }
    res.json({ success: true, filled, tats: tatClean.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ══ ONBOARDING_FMS_END ══

// POST /api/hr-report/upload — parsed Excel rows save karo.
// Same location + date-range ke purane rows REPLACE hote hain, isliye wahi
// mahina dobara upload karna hamesha safe hai (duplicate nahi banta).
app.post('/api/hr-report/upload', requireAuth, async (req, res) => {
  try {
    if (!(await hrReportAllowed(req))) return res.status(403).json({ error: 'Not allowed' });
    const { location, rows } = req.body || {};
    const loc = String(location || '').trim().toLowerCase();
    if (!HR_LOCATIONS.includes(loc)) return res.status(400).json({ error: 'Location galat hai (store/office/karigar)' });
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Excel me koi data row nahi mili' });

    const clean = [];
    for (const r of rows) {
      const date = String(r.date || '').trim();
      const name = String(r.name || '').trim();
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      clean.push({
        location: loc, emp_id: String(r.empId || '').trim(), emp_name: name,
        department: String(r.department || '').trim(), att_date: date,
        punch_in: String(r.punchIn || '').trim(), punch_out: String(r.punchOut || '').trim(),
        punch_in2: String(r.punchIn2 || '').trim(), punch_out2: String(r.punchOut2 || '').trim(),
        late_min: String(parseInt(r.lateMin) || 0), early_min: String(parseInt(r.earlyMin) || 0),
        absence_min: String(parseInt(r.absenceMin) || 0), total_min: String(parseInt(r.totalMin) || 0),
        note: String(r.note || '').trim(), manual: '0',
        uploaded_by: String(req.session.userId),
        created_at: new Date().toISOString().replace('T', ' ').split('.')[0]
      });
    }
    if (!clean.length) return res.status(400).json({ error: 'Kisi row me valid Name + Date nahi mila — Excel ka format check karo' });

    const d = await getDB();
    await ensureHRTab(d);

    // Is location + date-range ke purane rows hatao (re-upload = replace)
    const dates = clean.map(r => r.att_date).sort();
    const from = dates[0], to = dates[dates.length - 1];
    const existing = (await d.findAll('HR_Attendance'))
      .filter(r => r.location === loc && r.att_date >= from && r.att_date <= to);
    if (existing.length) {
      if (typeof d.batchDeleteByIds === 'function') {
        await d.batchDeleteByIds('HR_Attendance', existing.map(r => r.id));
      } else {
        for (const r of existing) await d.delete('HR_Attendance', r.id);
      }
    }
    await d.batchInsert('HR_Attendance', clean);
    res.json({ success: true, inserted: clean.length, replaced: existing.length, from, to });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/hr-report?location=&from=&to= — filtered rows
app.get('/api/hr-report', requireAuth, async (req, res) => {
  try {
    if (!(await hrReportAllowed(req))) return res.status(403).json({ error: 'Not allowed' });
    const loc = String(req.query.location || 'all').trim().toLowerCase();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const d = await getDB();
    await ensureHRTab(d);
    const rows = (await d.findAll('HR_Attendance'))
      .filter(r => (loc === 'all' || r.location === loc)
        && (!from || r.att_date >= from) && (!to || r.att_date <= to))
      .map(r => ({
        id: parseInt(r.id), location: r.location, empId: r.emp_id, name: r.emp_name,
        department: r.department, date: r.att_date,
        punchIn: r.punch_in || '', punchOut: r.punch_out || '',
        punchIn2: r.punch_in2 || '', punchOut2: r.punch_out2 || '',
        lateMin: parseInt(r.late_min) || 0, earlyMin: parseInt(r.early_min) || 0,
        absenceMin: parseInt(r.absence_min) || 0, totalMin: parseInt(r.total_min) || 0,
        note: r.note || '', manual: r.manual == 1
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr-report/delete — chune hue date range ka data delete (admin/HR).
// From/To dono zaroori hain — poora table kabhi blind delete nahi hota.
app.post('/api/hr-report/delete', requireAuth, async (req, res) => {
  try {
    if (!(await hrReportAllowed(req))) return res.status(403).json({ error: 'Not allowed' });
    const loc = String((req.body || {}).location || 'all').trim().toLowerCase();
    const from = String((req.body || {}).from || '').trim();
    const to = String((req.body || {}).to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return res.status(400).json({ error: 'From and To dates are required' });
    if (to < from) return res.status(400).json({ error: 'To date cannot be before From date' });
    if (loc !== 'all' && !HR_LOCATIONS.includes(loc))
      return res.status(400).json({ error: 'Invalid location' });
    const d = await getDB();
    await ensureHRTab(d);
    const existing = (await d.findAll('HR_Attendance'))
      .filter(r => (loc === 'all' || r.location === loc) && r.att_date >= from && r.att_date <= to);
    if (existing.length) {
      if (typeof d.batchDeleteByIds === 'function') {
        await d.batchDeleteByIds('HR_Attendance', existing.map(r => r.id));
      } else {
        for (const r of existing) await d.delete('HR_Attendance', r.id);
      }
    }
    res.json({ success: true, deleted: existing.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/hr-report/punchout — bhoola hua punch-out haath se daalo
app.post('/api/hr-report/punchout', requireAuth, async (req, res) => {
  try {
    if (!(await hrReportAllowed(req))) return res.status(403).json({ error: 'Not allowed' });
    const { id, punchOut } = req.body || {};
    const time = String(punchOut || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ error: 'Time HH:MM format me do (jaise 20:00)' });
    const d = await getDB();
    await ensureHRTab(d);
    const row = await d.findOne('HR_Attendance', { id: String(id) });
    if (!row) return res.status(404).json({ error: 'Row not found' });
    await d.update('HR_Attendance', String(id), { punch_out: time, manual: '1' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MIS
// ══════════════════════════════════════════════════════
app.get('/api/mis', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const seeAll = await misSeesAll(req);
    const isHod = req.session.role === 'hod' && !seeAll;
    // Doer (normal user) ko sirf apni report dikhti hai
    const selfOnly = !seeAll && !['admin', 'hod', 'pc'].includes(req.session.role) ? String(req.session.userId) : null;
    const todayStr = today();

    const allUsers = await db.findAll('Users');
    let hodDept = '';
    if (isHod) {
      const meUser = await db.findOne('Users', { id: String(req.session.userId) });
      hodDept = meUser?.department || '';
    }

    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const calcScore = (total, pending, overdue, revised) => {
      total = parseInt(total) || 0; pending = parseInt(pending) || 0;
      overdue = parseInt(overdue) || 0; revised = parseInt(revised) || 0;
      return total > 0 ? Math.max(-100, Math.round((0 - (pending / total) * 100 - (overdue / total) * 50 - (revised / total) * 25) * 10) / 10) : 0;
    };

    const aggregateTasks = (tasks, type) => {
      const result = {};
      for (const t of tasks) {
        if (!t.due_date || t.due_date < start || t.due_date > end) continue;
        const u = userMap[String(t.assigned_to)];
        if (!u) continue;
        if (isHod && u.department !== hodDept) continue;
        if (selfOnly && String(t.assigned_to) !== selfOnly) continue;
        const uid = String(t.assigned_to);
        if (!result[uid]) result[uid] = { userId: parseInt(uid), name: u.name, total: 0, pending: 0, completed: 0, revised: 0, overdue: 0 };
        result[uid].total++;
        if (t.status === 'pending') { result[uid].pending++; if (t.due_date < todayStr) result[uid].overdue++; }
        // 'closed' = complete hone ke baad band kiya gaya task — MIS me completed jaisa count hota hai
        if (t.status === 'completed' || t.status === 'closed') result[uid].completed++;
        if (type === 'delegation' && t.status === 'revised') result[uid].revised++;
      }
      return Object.values(result).map(r => ({
        ...r, delayed: r.overdue,
        score: calcScore(r.total, r.pending, r.overdue, r.revised)
      }));
    };

    const delTasks = await db.findAll('Delegation_Tasks');
    const chlTasks = await db.findAll('Checklist_Tasks');
    res.json({
      delegation: aggregateTasks(delTasks, 'delegation'),
      checklist: aggregateTasks(chlTasks, 'checklist')
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis/detail', requireAuth, async (req, res) => {
  try {
    const { userId, type, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
    // Doer sirf apni detail dekh sakta hai
    if (!['admin', 'hod', 'pc'].includes(req.session.role) && String(userId) !== String(req.session.userId) && !(await misSeesAll(req))) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const tabName = type === 'delegation' ? 'Delegation_Tasks' : 'Checklist_Tasks';
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const tasks = (await db.findAll(tabName))
      .filter(t => String(t.assigned_to) === String(userId) && t.due_date >= start && t.due_date <= end)
      .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
      .map(t => ({
        id: parseInt(t.id), description: t.description, status: t.status,
        due_date: t.due_date,
        assigned_by_name: userMap[String(t.assigned_by)]?.name || ''
      }));
    res.json({ tasks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis/all', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const seeAll = await misSeesAll(req);
    const isHod = req.session.role === 'hod' && !seeAll;
    // Doer (normal user) ko sirf apni row dikhti hai
    const selfOnly = !seeAll && !['admin', 'hod', 'pc'].includes(req.session.role) ? String(req.session.userId) : null;
    const todayStr = today();

    const allUsers = await db.findAll('Users');
    let hodDept = '';
    if (isHod) {
      const meUser = await db.findOne('Users', { id: String(req.session.userId) });
      hodDept = meUser?.department || '';
    }
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const calc = (total, pending, overdue, revised) => {
      total = parseInt(total) || 0; pending = parseInt(pending) || 0;
      overdue = parseInt(overdue) || 0; revised = parseInt(revised) || 0;
      const score = total > 0 ? Math.max(-100, Math.round((0 - (pending / total) * 100 - (overdue / total) * 50 - (revised / total) * 25) * 10) / 10) : 0;
      return { total, pending, overdue, revised, score, completed: 0 };
    };

    const userStats = {};
    const ensure = (uid) => {
      const u = userMap[String(uid)];
      if (!u) return null;
      if (isHod && u.department !== hodDept) return null;
      if (selfOnly && String(uid) !== selfOnly) return null;
      if (!userStats[uid]) {
        userStats[uid] = {
          userId: parseInt(uid), name: u.name, department: u.department || '',
          delegation: calc(0, 0, 0, 0),
          checklist: calc(0, 0, 0, 0)
        };
      }
      return userStats[uid];
    };

    // ── MIS SCORING POLICY (transfer / reopen / close) ──
    // Transfer: task ka assigned_to naye doer par chala jaata hai, isliye task
    //   sirf NAYE doer ke score me ginta hai — purane doer par koi asar nahi.
    // Reopen: completed → pending wapas, doer ke score me phir pending ginta
    //   hai (overdue ho to overdue bhi) jab tak dobara complete na ho.
    // Close: 'closed' = complete karke band kiya gaya task — completed jaisa
    //   POSITIVE ginta hai, doer ka score isse kabhi nahi girta.
    const delTasks = await db.findAll('Delegation_Tasks');
    for (const t of delTasks) {
      if (!t.due_date || t.due_date < start || t.due_date > end) continue;
      const e = ensure(t.assigned_to);
      if (!e) continue;
      const d = e.delegation;
      d.total++;
      if (t.status === 'pending') { d.pending++; if (t.due_date < todayStr) d.overdue++; }
      if (t.status === 'completed' || t.status === 'closed') d.completed++;
      if (t.status === 'revised') d.revised++;
      d.score = d.total > 0 ? Math.max(-100, Math.round((0 - (d.pending / d.total) * 100 - (d.overdue / d.total) * 50 - (d.revised / d.total) * 25) * 10) / 10) : 0;
    }

    const chlTasks = await db.findAll('Checklist_Tasks');
    for (const t of chlTasks) {
      if (!t.due_date || t.due_date < start || t.due_date > end) continue;
      const e = ensure(t.assigned_to);
      if (!e) continue;
      const c = e.checklist;
      c.total++;
      if (t.status === 'pending') { c.pending++; if (t.due_date < todayStr) c.overdue++; }
      if (t.status === 'completed' || t.status === 'closed') c.completed++;
      c.score = c.total > 0 ? Math.max(-100, Math.round((0 - (c.pending / c.total) * 100 - (c.overdue / c.total) * 50) * 10) / 10) : 0;
    }

    const allPlans = await db.findAll('Week_Plans');
    const planMap = {};
    for (const p of allPlans) {
      if (p.start_date >= start && p.start_date <= end && !planMap[p.employee_id]) {
        planMap[p.employee_id] = p;
      }
    }

    const rows = Object.values(userStats).map(u => {
      const d = u.delegation, c = u.checklist;
      const totalAll = d.total + c.total;
      const pendingAll = d.pending + c.pending;
      const overdueAll = d.overdue + c.overdue;
      const revisedAll = d.revised;
      const completedAll = (d.completed || 0) + (c.completed || 0);
      const overallScore = totalAll > 0
        ? Math.max(-100, Math.round((0 - (pendingAll / totalAll) * 100 - (overdueAll / totalAll) * 50 - (revisedAll / totalAll) * 25) * 10) / 10)
        : null;
      const plan = planMap[String(u.userId)] || null;
      return {
        ...u,
        fms: { total: 0, pending: 0, done: 0, score: null },
        totalAll, pendingAll, overdueAll, revisedAll, completedAll, overallScore,
        plan: plan ? { start_date: plan.start_date, target_count: parseInt(plan.target_count) || 0, improvement_pct: plan.improvement_pct !== '' ? parseInt(plan.improvement_pct) : null } : null
      };
    }).filter(u => u.totalAll > 0).sort((a, b) => a.name.localeCompare(b.name));

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/mis/fms', requireAuth, async (req, res) => {
  if (!['admin', 'hod', 'pc'].includes(req.session.role) && !(await misSeesAll(req))) return res.status(403).json({ error: 'Admin or HOD only' });
  try {
    const d = await getDB();
    let fmsList = [];
    try { await ensureFMSConfigTab(d); fmsList = await d.findAll('FMS_Config'); } catch(e) { return res.json([]); }
    if (!fmsList.length) return res.json([]);

    const todayStr = today();
    const result = [];

    for (const fmsRow of fmsList) {
      const fms = parseFMSRow(fmsRow);
      if (!fms.sheet_id || !fms.sheet_name || !fms.steps.length) continue;
      try {
        const spreadsheetId = extractSheetId(fms.sheet_id);
        const resp = await withRetry(() => d.sheets.spreadsheets.values.get({
          spreadsheetId, range: `${fms.sheet_name}!A:Z`
        }));
        const allRows = resp.data.values || [];
        if (allRows.length < fms.header_row) continue;
        const headers = allRows[fms.header_row - 1] || [];
        const rawDataRows = allRows.slice(fms.header_row);
        // Filter out empty/template rows (only checkboxes/formulas, no real data)
        const dataRows = rawDataRows.filter(row => {
          const checkLen = Math.min(10, headers.length);
          for (let i = 0; i < checkLen; i++) {
            const v = (row[i] || '').trim();
            if (v && v.toUpperCase() !== 'FALSE' && v.toUpperCase() !== 'TRUE') return true;
          }
          return false;
        });

        const stepRows = fms.steps.map((step, si) => {
          const aIdx = colLetterToIdx(step.actualCol || '');
          const pIdx = colLetterToIdx(step.planCol   || '');
          // Previous steps' actualCol indices for prerequisite checking
          const prevActualIdxs = fms.steps.slice(0, si)
            .map(s => colLetterToIdx(s.actualCol || ''))
            .filter(i => i >= 0);
          let pending=0, done=0, late=0;
          for (const row of dataRows) {
            const actual = aIdx>=0 ? (row[aIdx]||'').trim() : '';
            const plan   = pIdx>=0 ? (row[pIdx]||'').trim() : '';
            const isDoneVal = actual && actual.toUpperCase() !== 'FALSE';
            if (isDoneVal) { done++; continue; }
            // Check if previous steps are done — if not, skip this row entirely
            let prevNotDone = false;
            for (const prevIdx of prevActualIdxs) {
              const pv = (row[prevIdx]||'').trim();
              if (!pv || pv.toUpperCase() === 'FALSE') { prevNotDone = true; break; }
            }
            if (prevNotDone) continue; // row not yet eligible for this step
            pending++;
            if (plan && plan < todayStr) late++;
          }
          const doerNames = Array.isArray(step.doers) ? step.doers.join(', ') : (step.doers||'');
          return {
            stepId: step.id || si+1,
            stepOrder: si+1,
            stepName: step.stepName,
            doers: doerNames,
            pending, done, late, total: pending+done
          };
        });
        const totalPending = stepRows.reduce((a,s)=>a+s.pending,0);
        const totalDone    = stepRows.reduce((a,s)=>a+s.done,0);
        result.push({
          fmsId: fms.id, fmsName: fms.fms_name, steps: stepRows,
          totalPending, totalDone,
          // Frontend-compat fields
          total: totalPending + totalDone,
          pending: totalPending,
          done: totalDone
        });
      } catch(e) { console.error('mis/fms error:', fms.fms_name, e.message); }
    }
    res.json(result);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Employee Records ──
app.get('/api/employee-records', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const db = await getDB();
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'Dates required' });
    const isHod = req.session.role === 'hod';
    const todayStr = today();

    const allUsers = await db.findAll('Users');
    let hodDept = '';
    if (isHod) {
      const meUser = await db.findOne('Users', { id: String(req.session.userId) });
      hodDept = meUser?.department || '';
    }
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const calcScore = (total, pending, overdue, revised) => {
      total = parseInt(total) || 0; pending = parseInt(pending) || 0;
      overdue = parseInt(overdue) || 0; revised = parseInt(revised) || 0;
      return total > 0 ? Math.max(-100, Math.round((0 - (pending / total) * 100 - (overdue / total) * 50 - (revised / total) * 25) * 10) / 10) : null;
    };

    const map = {};
    const ensure = (uid) => {
      const u = userMap[String(uid)];
      if (!u) return null;
      if (isHod && u.department !== hodDept) return null;
      if (!map[uid]) {
        map[uid] = {
          userId: parseInt(uid), name: u.name, department: u.department || '',
          del: { total: 0, pending: 0, completed: 0, revised: 0, overdue: 0 },
          chl: { total: 0, pending: 0, completed: 0, overdue: 0 },
          fms: { total: 0, pending: 0, done: 0 }
        };
      }
      return map[uid];
    };

    const delTasks = await db.findAll('Delegation_Tasks');
    const delPending = {}, chlPending = {};

    for (const t of delTasks) {
      if (!t.due_date || t.due_date < start || t.due_date > end) continue;
      const e = ensure(t.assigned_to);
      if (!e) continue;
      e.del.total++;
      if (t.status === 'pending') { e.del.pending++; if (t.due_date < todayStr) e.del.overdue++; }
      if (t.status === 'completed') e.del.completed++;
      if (t.status === 'revised') e.del.revised++;
      if ((t.status === 'pending' || t.status === 'revised')) {
        const uid = String(t.assigned_to);
        if (!delPending[uid]) delPending[uid] = [];
        delPending[uid].push({ description: t.description, status: t.status, due_date: t.due_date });
      }
    }

    const chlTasks = await db.findAll('Checklist_Tasks');
    for (const t of chlTasks) {
      if (!t.due_date || t.due_date < start || t.due_date > end) continue;
      const e = ensure(t.assigned_to);
      if (!e) continue;
      e.chl.total++;
      if (t.status === 'pending') { e.chl.pending++; if (t.due_date < todayStr) e.chl.overdue++; }
      if (t.status === 'completed') e.chl.completed++;
      if (t.status === 'pending') {
        const uid = String(t.assigned_to);
        if (!chlPending[uid]) chlPending[uid] = [];
        chlPending[uid].push({ description: t.description, status: t.status, due_date: t.due_date });
      }
    }

    const allPlans = await db.findAll('Week_Plans');
    const planMap = {};
    for (const p of allPlans) {
      if (p.start_date >= start && p.start_date <= end && !planMap[p.employee_id]) planMap[p.employee_id] = p;
    }

    const rows = Object.values(map).map(e => {
      const total = e.del.total + e.chl.total;
      const pending = e.del.pending + e.chl.pending;
      const done = e.del.completed + e.chl.completed;
      const overdue = e.del.overdue + e.chl.overdue;
      const revised = e.del.revised;
      const score = calcScore(total, pending, overdue, revised);
      const plan = planMap[String(e.userId)] || null;
      const uid = String(e.userId);
      return {
        userId: e.userId, name: e.name, department: e.department,
        committed: plan ? {
          start_date: plan.start_date,
          target_count: parseInt(plan.target_count) || 0,
          improvement_pct: plan.improvement_pct !== '' ? parseInt(plan.improvement_pct) : null
        } : null,
        total, done, pending, overdue, revised, score,
        breakdown: {
          delegation: { total: e.del.total, done: e.del.completed, pending: e.del.pending },
          checklist: { total: e.chl.total, done: e.chl.completed, pending: e.chl.pending },
          fms: { total: 0, done: 0, pending: 0 }
        },
        pendingTasks: {
          delegation: delPending[uid] || [],
          checklist: chlPending[uid] || [],
          fms: []
        }
      };
    }).filter(r => r.total > 0 || r.committed)
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ rows, fmsErrors: [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── FMS Dashboard — aggregate pending rows from all FMS external sheets ──
app.get('/api/fms-dashboard', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    let fmsList = [];
    try { await ensureFMSConfigTab(d); fmsList = await d.findAll('FMS_Config'); } catch(e) { return res.json({ rows:[], pendingCount:0 }); }
    if (!fmsList.length) return res.json({ rows:[], pendingCount:0 });

    const todayStr = today();
    const pendingRows = [];

    for (const fmsRow of fmsList) {
      const fms = parseFMSRow(fmsRow);
      if (!fms.sheet_id || !fms.sheet_name || !fms.steps.length) continue;
      try {
        const spreadsheetId = extractSheetId(fms.sheet_id);
        const resp = await withRetry(() => d.sheets.spreadsheets.values.get({
          spreadsheetId, range: `${fms.sheet_name}!A:Z`
        }));
        const allRows = resp.data.values || [];
        if (allRows.length < fms.header_row) continue;
        const headers = allRows[fms.header_row - 1] || [];
        const rawRows = allRows.slice(fms.header_row);
        // Filter out empty/template rows
        const dataRows = rawRows.filter(row => {
          const checkLen = Math.min(10, headers.length);
          for (let i = 0; i < checkLen; i++) {
            const v = (row[i] || '').trim();
            if (v && v.toUpperCase() !== 'FALSE' && v.toUpperCase() !== 'TRUE') return true;
          }
          return false;
        });

        fms.steps.forEach((step, si) => {
          if (!step.actualCol) return;
          const aIdx = colLetterToIdx(step.actualCol);
          const pIdx = colLetterToIdx(step.planCol || '');

          // Previous steps' actualCol indices — all must be done before this step shows as pending
          const prevActualIdxs = fms.steps.slice(0, si)
            .map(s => colLetterToIdx(s.actualCol || ''))
            .filter(i => i >= 0);

          dataRows.forEach((row, ri) => {
            const actual = (row[aIdx]||'').trim();
            if (actual && actual.toUpperCase() !== 'FALSE') return; // already done
            // Skip if any previous step is not yet done
            for (const prevIdx of prevActualIdxs) {
              const prevVal = (row[prevIdx]||'').trim();
              if (!prevVal || prevVal.toUpperCase() === 'FALSE') return;
            }
            const planVal = pIdx>=0 ? (row[pIdx]||'').trim() : '';

            // Parse plan date
            let planDate = null;
            const m1 = planVal.match(/(\d{4}-\d{2}-\d{2})/);
            const m2 = planVal.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
            if (m1) planDate = m1[1];
            else if (m2) planDate = `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;

            const isLate = planDate ? planDate < todayStr : false;
            const doerNames = (step.doers||[]).join(', ') || '—';

            pendingRows.push({
              fmsId: fms.id, fmsName: fms.fms_name,
              stepId: step.id || si+1, stepName: step.stepName,
              rowIndex: fms.header_row + ri + 1,
              doer: doerNames,
              planValue: planVal, planDate, isLate
            });
          });
        });
      } catch(e) { console.error('fms-dashboard error:', fms.fms_name, e.message); }
    }

    res.json({ rows: pendingRows, pendingCount: pendingRows.length });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// USERS WITH PENDING TASKS
// ══════════════════════════════════════════════════════
app.get('/api/users/with-pending-tasks', requireAuth, async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const todayStr = today();
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const checkTask = (t) => {
      if (t.status !== 'pending') return false;
      const due = t.due_date || '';
      if (dateFrom && dateTo) return due >= dateFrom && due <= dateTo;
      return due <= todayStr;
    };

    const userIdsWithPending = new Set();
    const delTasks = await db.findAll('Delegation_Tasks');
    for (const t of delTasks) if (checkTask(t)) userIdsWithPending.add(String(t.assigned_to));
    const chlTasks = await db.findAll('Checklist_Tasks');
    for (const t of chlTasks) if (checkTask(t)) userIdsWithPending.add(String(t.assigned_to));

    const result = allUsers
      .filter(u => userIdsWithPending.has(String(u.id)) && !['admin', 'pc'].includes(u.role))
      .map(u => ({ id: parseInt(u.id), name: u.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// USERS
// ══════════════════════════════════════════════════════
// ══ USERS_PW_ROUTE_START ══
// Admin: kai users ke password ek saath -- Users page ka role tab khulte hi us tab ke
// password dikhane ke liye (Harsh, 17 Oct). Is app me password seedha DB me rakha hota hai
// (login "user.password !== password" se milta hai), isliye yahi asli password hai.
// SIRF admin; baaki sab ko 403. Password ka text log me kabhi nahi likhte -- sirf ginti.
app.get('/api/users/passwords', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map(x => parseInt(x, 10))
      .filter(x => Number.isInteger(x) && x > 0)
      .slice(0, 500);
    if (!ids.length) return res.json({ passwords: {} });
    const want = new Set(ids.map(String));
    const all = await db.findAll('Users');
    const passwords = {};
    all.forEach(u => {
      if (u && want.has(String(u.id)) && u.password) passwords[u.id] = String(u.password);
    });
    console.log('  Password dekhe (admin id ' + req.session.userId + '): ' + Object.keys(passwords).length + ' users');
    res.json({ passwords });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ══ USERS_PW_ROUTE_END ══

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const all = await db.findAll('Users');
    const result = all.filter(u => u && u.id && u.name).map(u => ({
      id: parseInt(u.id), name: u.name, email: u.email,
      notification_email: u.notification_email || '',
      role: u.role, phone: u.phone || '',
      department: u.department || '', week_off: u.week_off || '',
      extra_off: u.extra_off || '',
      // Sirf admin ko: password set hai ya nahi (password khud is list me KABHI nahi jaata)
      ...(req.session.role === 'admin' ? { hasPassword: !!u.password } : {})
    }));
    // Sort: admin first, then by name
    result.sort((a, b) => {
      const roleOrder = { admin: 0, hod: 1, pc: 2, user: 3 };
      const ra = roleOrder[a.role] ?? 4, rb = roleOrder[b.role] ?? 4;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, password, role, phone, department, week_off, extra_off } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const allUsers = await db.findAll('Users');
    const existing = allUsers.find(u => u.email && u.email.trim().toLowerCase() === (email || '').trim().toLowerCase());
    if (existing) return res.status(400).json({ error: 'Email already exists' });
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    await db.insert('Users', {
      name, email, notification_email: notification_email || '',
      password: password,
      role: role || 'user', phone: phone || '',
      department: department || '', week_off: week_off || '',
      extra_off: extra_off || '', profile_image: '', created_at: nowStr
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, notification_email, role, password, phone, department, week_off, extra_off } = req.body;
    const upd = { name, email, notification_email: notification_email || '', role, phone: phone || '', department: department || '', week_off: week_off || '', extra_off: extra_off || '' };
    if (password) upd.password = password;
    // NAAM BADLA to uske checklist task ka doer_name bhi saath badlo.
    // Pehle ye nahi hota tha: "Naresh" ka naam "NARESH VERMA" kar diya gaya
    // aur uske 165 task me doer_name "Naresh" hi pada reh gaya. phpMyAdmin me
    // dekhne par lagta tha ki task kisi aur ka hai -- jabki task sahi bande
    // ke paas hi tha. (15 Sep 2026)
    const puraana = await db.findOne('Users', { id: req.params.id });
    const naamBadla = puraana && name && String(puraana.name || '').trim() !== String(name).trim();
    await db.update('Users', req.params.id, upd);
    let labelBadle = 0;
    if (naamBadla) {
      try {
        labelBadle = await syncDoerName(req.params.id, name);
        console.log(`  user rename "${puraana.name}" -> "${name}": ${labelBadle} checklist row ka doer_name bhi badla`);
      } catch (e) {
        // Label badalna sirf padhne ki aasani ke liye hai -- fail ho to bhi
        // rename ruke nahi. App to assigned_to hi padhti hai.
        console.error('  doer_name sync fail:', e.message);
      }
    }
    res.json({ success: true, doerLabelUpdated: labelBadle });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// HOLIDAYS — sabko dikhti hain, badalta sirf admin hai
// ══════════════════════════════════════════════════════
// Pehle ye localStorage me thin, isliye ek bande ki daali hui chhutti kisi
// doosre ko dikhti hi nahi thi (na usi bande ko doosre phone par). Harsh
// (16 Sep 2026): "sabhi ko show honi chahiye." Ab DB se aati hain.

// Padhna sab kar sakte hain — chhutti sabke kaam ki cheez hai
app.get('/api/holidays', requireAuth, async (req, res) => {
  try {
    const rows = await db.findAll('Holidays');
    rows.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
    res.json(rows.map(h => ({ id: h.id, date: h.date, name: h.name })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/holidays', requireAuth, requireAdmin, async (req, res) => {
  try {
    const date = toIsoDateSrv(req.body?.date);
    const name = String(req.body?.name || '').trim();
    if (!date) return res.status(400).json({ error: `Invalid date: "${req.body?.date}" — use YYYY-MM-DD or DD-MM-YYYY` });
    if (!name) return res.status(400).json({ error: 'Holiday name is required' });
    // Ek hi din do baar na jude
    const pehle = (await db.findAll('Holidays')).find(h => String(h.date) === date);
    if (pehle) return res.status(409).json({ error: `${date} is already a holiday: ${pehle.name}` });
    const row = await db.insert('Holidays', {
      date, name,
      created_at: new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0]
    });
    res.json({ success: true, id: row.id, date, name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/holidays/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await db.delete('Holidays', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });

    // Harsh (10 Sep 2026): "pehle warning aaye." Shivam ka account hatane par
    // uske 18 khule task bina doer ke reh gaye the aur list me "-" dikh raha
    // tha. Ab pehle batate hain ki kitne khule task hain; jaan-boojh kar aage
    // badhna ho to ?force=1 ke saath dobara request aati hai.
    if (String(req.query.force || '') !== '1') {
      const uid = String(req.params.id);
      const [chl, del] = await Promise.all([
        db.findAll('Checklist_Tasks').catch(() => []),
        db.findAll('Delegation_Tasks').catch(() => [])
      ]);
      const isOpen = t => t.status === 'pending' || t.status === 'revised';
      const mine = t => String(t.assigned_to || '') === uid;
      const chlN = chl.filter(t => mine(t) && isOpen(t)).length;
      const delN = del.filter(t => mine(t) && isOpen(t)).length;
      if (chlN + delN > 0) {
        return res.status(409).json({
          needsConfirm: true, openTasks: chlN + delN, checklist: chlN, delegation: delN,
          error: `Is bande ke ${chlN + delN} khule task hain (checklist ${chlN}, delegation ${delN}).`
        });
      }
    }

    await deleteRow('Users', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users/bulk', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { users } = req.body;
    if (!users || !users.length) return res.status(400).json({ error: 'No users provided' });
    let added = 0, skipped = 0, errors = [];
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    for (const u of users) {
      if (!u.name || !u.email || !u.password) { errors.push(`${u.email || '?'}: missing fields`); continue; }
      const existing = await db.findOne('Users', { email: u.email });
      if (existing) { skipped++; continue; }
      await db.insert('Users', {
        name: u.name, email: u.email, notification_email: '',
        password: u.password,
        role: u.role || 'user', phone: u.phone || '',
        department: u.department || '', week_off: u.week_off || '',
        extra_off: u.extra_off || '', profile_image: '', created_at: nowStr
      });
      added++;
    }
    res.json({ success: true, added, skipped, errors });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const user = await db.findOne('Users', { id: String(req.session.userId) });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      id: parseInt(user.id),
      name: user.name,
      email: user.email,
      notification_email: user.notification_email || '',
      role: user.role,
      phone: user.phone || '',
      department: user.department || '',
      week_off: user.week_off || '',
      extra_off: user.extra_off || '',
      profile_image: user.profile_image || ''
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { name, email, notification_email, phone, currentPassword, newPassword, profileImage } = req.body;
    if (currentPassword) {
      const user = await db.findOne('Users', { id: String(uid) });
      if (currentPassword !== user.password)
        return res.status(400).json({ error: 'Current password is incorrect' });
      const upd = { name, email, notification_email: notification_email || '', phone: phone || '' };
      if (newPassword) upd.password = newPassword;
      await db.update('Users', String(uid), upd);
    } else {
      await db.update('Users', String(uid), { name, email, notification_email: notification_email || '', phone: phone || '' });
    }
    if (profileImage !== undefined) await db.update('Users', String(uid), { profile_image: profileImage || '' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/profile/image', requireAuth, async (req, res) => {
  try {
    await db.update('Users', String(req.session.userId), { profile_image: req.body.image || '' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// COMMENTS
// ══════════════════════════════════════════════════════
app.get('/api/comments/:type/:taskId', requireAuth, async (req, res) => {
  try {
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    const comments = await db.findWhere('Task_Comments', { task_id: req.params.taskId, task_type: req.params.type });
    const result = comments.map(c => ({
      id: parseInt(c.id), comment: c.comment, created_at: c.created_at,
      userName: userMap[String(c.user_id)]?.name || ''
    })).sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/comments', requireAuth, async (req, res) => {
  try {
    const { taskId, taskType, comment } = req.body;
    if (!comment || !taskId || !taskType) return res.status(400).json({ error: 'All fields required' });
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    await db.insert('Task_Comments', {
      task_id: String(taskId), task_type: taskType,
      user_id: String(req.session.userId), comment, created_at: nowStr
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const comment = await db.findOne('Task_Comments', { id: req.params.id });
    if (!comment) return res.status(404).json({ error: 'Not found' });
    if (String(comment.user_id) !== String(req.session.userId) && req.session.role !== 'admin')
      return res.status(403).json({ error: 'Not allowed' });
    await deleteRow('Task_Comments', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// FMS ROUTES — Full implementation
// ══════════════════════════════════════════════════════

// Helper: extract spreadsheet ID from URL or raw ID
function extractSheetId(raw) {
  if (!raw) return '';
  const m = String(raw).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw.trim();
}

// Helper: convert 0-based column index to letter(s) A, B, ..., Z, AA, AB...
function idxToColLetter(idx) {
  let letter = '';
  let n = idx + 1; // 1-based
  while (n > 0) {
    n--;
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26);
  }
  return letter;
}

// Helper: convert column letter(s) A, Z, AA, AB... to 0-based index
function colLetterToIdx(letter) {
  if (!letter) return -1;
  const s = letter.trim().toUpperCase();
  let idx = 0;
  for (let i = 0; i < s.length; i++) {
    idx = idx * 26 + (s.charCodeAt(i) - 64);
  }
  return idx - 1; // 0-based
}

// Helper: convert header string array to [{col, name, index}] objects
function headersToObjects(arr) {
  return arr.map((name, i) => ({ col: idxToColLetter(i), name: name || `Col_${idxToColLetter(i)}`, index: i }));
}

// Helper: ensure FMS_Config tab exists in main spreadsheet
async function ensureFMSConfigTab(d) {
  try {
    await d.findAll('FMS_Config');
  } catch(e) {
    // Tab missing — create it with headers
    try {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'FMS_Config' } } }] }
      }));
    } catch(e2) { /* already exists race */ }
    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'FMS_Config!A1:H1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['id','fms_name','sheet_name','sheet_id','header_row','total_steps','steps_json','created_at']] }
    }));
    delete d._hdrCache['FMS_Config'];
    delete d._cache['FMS_Config'];
  }
}

// Helper: ensure Leave_Requests tab exists in main spreadsheet
// (MySQL me table schema se auto-ban jaati hai — wahan findAll fail nahi hota)
async function ensureLeaveTab(d) {
  try {
    await d.findAll('Leave_Requests');
  } catch(e) {
    // Tab missing — create it with headers
    try {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Leave_Requests' } } }] }
      }));
    } catch(e2) { /* already exists race */ }
    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Leave_Requests!A1:H1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['id','user_id','from_date','to_date','reason','status','note','created_at']] }
    }));
    delete d._hdrCache['Leave_Requests'];
    delete d._cache['Leave_Requests'];
  }
}

// Helper: App_State tab ensure karo (MySQL me schema se auto ban jaati hai;
// Google Sheets me pehli baar khud banani padti hai)
async function ensureAppStateTab(d) {
  try {
    await d.findAll('App_State');
  } catch (e) {
    try {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'App_State' } } }] }
      }));
    } catch (e2) { /* already exists race */ }
    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'App_State!A1:D1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['id', 'key_name', 'value', 'updated_at']] }
    }));
    delete d._hdrCache['App_State'];
    delete d._cache['App_State'];
  }
}

// Parse FMS row from sheet
function parseFMSRow(row) {
  let steps = [];
  try { steps = JSON.parse(row.steps_json || '[]'); } catch(e) {}
  return {
    id: parseInt(row.id),
    fms_name: row.fms_name || row.sheet_name,
    sheet_name: row.sheet_name,
    sheet_id: row.sheet_id,
    header_row: parseInt(row.header_row) || 1,
    total_steps: parseInt(row.total_steps) || 1,
    steps,
    created_at: row.created_at
  };
}

// POST /api/fms/fetch-headers — must be BEFORE /:id route
app.post('/api/fms/fetch-headers', requireAuth, async (req, res) => {
  try {
    const { sheetId, sheetName, headerRow = 1 } = req.body;
    if (!sheetId || !sheetName)
      return res.status(400).json({ error: 'sheetId aur sheetName dono required hain' });

    const spreadsheetId = extractSheetId(sheetId);
    const d = await getDB();
    const rowNum = parseInt(headerRow) || 1;

    const response = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!${rowNum}:${rowNum}`
    }));

    const rawHeaders = (response.data.values && response.data.values[0]) ? response.data.values[0] : [];
    if (!rawHeaders.length)
      return res.json({ headers: [], error: 'No headers found — sheet tab name ya row number check karo' });

    res.json({ headers: headersToObjects(rawHeaders) });
  } catch(err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403') || msg.toLowerCase().includes('forbidden'))
      msg = 'Access denied (403) — sheet ko service account email ke saath Editor access de kar share karo';
    else if (msg.includes('404') || msg.toLowerCase().includes('not found'))
      msg = 'Sheet not found (404) — Sheet ID ya Tab name galat hai, check karo';
    else if (msg.includes('400'))
      msg = 'Invalid request (400) — Tab name mein special characters avoid karo';
    res.status(500).json({ error: msg });
  }
});

// GET /api/fms — list all
app.get('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    await ensureFMSConfigTab(d);
    const rows = await d.findAll('FMS_Config');
    res.json(rows.map(parseFMSRow));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/fms/:id — single FMS with steps
app.get('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    await ensureFMSConfigTab(d);
    const row = await d.findOne('FMS_Config', { id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'FMS not found' });
    const fms = parseFMSRow(row);
    res.json({ sheet: fms, steps: fms.steps });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/fms — create
app.post('/api/fms', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    await ensureFMSConfigTab(d);
    const { fmsName, sheetName, sheetId, headerRow, totalSteps, steps } = req.body;
    if (!sheetName || !sheetId) return res.status(400).json({ error: 'sheetName aur sheetId required hain' });
    const nowStr = new Date().toISOString().replace('T',' ').split('.')[0];
    const inserted = await d.insert('FMS_Config', {
      fms_name: fmsName || sheetName,
      sheet_name: sheetName,
      sheet_id: extractSheetId(sheetId),
      header_row: String(parseInt(headerRow)||1),
      total_steps: String(parseInt(totalSteps)||1),
      steps_json: JSON.stringify(steps || []),
      created_at: nowStr
    });
    res.json({ id: parseInt(inserted.id), fms_name: inserted.fms_name, ...inserted });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/fms/:id — update
app.put('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    const { fmsName, sheetName, sheetId, headerRow, totalSteps, steps } = req.body;
    const upd = {};
    if (fmsName !== undefined)    upd.fms_name    = fmsName;
    if (sheetName !== undefined)  upd.sheet_name  = sheetName;
    if (sheetId !== undefined)    upd.sheet_id    = extractSheetId(sheetId);
    if (headerRow !== undefined)  upd.header_row  = String(parseInt(headerRow)||1);
    if (totalSteps !== undefined) upd.total_steps = String(parseInt(totalSteps)||1);
    if (steps !== undefined)      upd.steps_json  = JSON.stringify(steps);
    await d.update('FMS_Config', req.params.id, upd);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/fms/:id
app.delete('/api/fms/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    await d.delete('FMS_Config', req.params.id);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/fms/:id/sync — fetch headers from external sheet
app.get('/api/fms/:id/sync', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    const row = await d.findOne('FMS_Config', { id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'FMS not found' });
    const spreadsheetId = extractSheetId(row.sheet_id);
    const headerRow = parseInt(row.header_row) || 1;
    const response = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId, range: `${row.sheet_name}!${headerRow}:${headerRow}`
    }));
    const rawHeaders = response.data.values?.[0] || [];
    const dataRes = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId, range: `${row.sheet_name}!A:Z`
    }));
    const totalRows = Math.max(0, (dataRes.data.values?.length || 0) - headerRow);
    res.json({ success: true, headers: headersToObjects(rawHeaders), headerRow, totalRows, sample: [] });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/fms-tasks — list FMS configs (for task view dropdown)
app.get('/api/fms-tasks', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    await ensureFMSConfigTab(d);
    const rows = await d.findAll('FMS_Config');
    res.json(rows.map(r => ({
      id: parseInt(r.id),
      fms_name: r.fms_name || r.sheet_name,
      sheet_name: r.sheet_name,
      sheet_id: r.sheet_id,
      header_row: parseInt(r.header_row)||1,
      total_steps: parseInt(r.total_steps)||1
    })));
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/fms-tasks/:id — single FMS for task view (enriched with user names)
app.get('/api/fms-tasks/:id', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const row = await d.findOne('FMS_Config', { id: String(req.params.id) });
    if (!row) return res.status(404).json({ error: 'FMS not found' });
    const fms = parseFMSRow(row);
    const allUsers = await d.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;
    const myId = String(req.session.userId);

    // Enrich steps with frontend-expected field names + user objects
    const enrichedSteps = fms.steps.map((s, si) => {
      const doerIds = Array.isArray(s.doers) ? s.doers : [];
      const doerObjs = doerIds.map(uid => {
        const u = userMap[String(uid)];
        return u ? { id: parseInt(uid), name: u.name } : { id: parseInt(uid), name: String(uid) };
      });
      const isMyStep = req.session.role === 'admin' || doerIds.map(String).includes(myId);
      return {
        id: s.id || si+1,
        step_name: s.stepName,
        step_order: si+1,
        doers: doerObjs,
        isMyStep,
        planCol: s.planCol || '',
        actualCol: s.actualCol || '',
        delayReasonCol: s.delayReasonCol || '',
        doerNameCol: s.doerNameCol || '',
        showCols: s.showCols || [],
        extraInput: s.extraInput || 'no',
        extraRows: s.extraRows || []
      };
    });
    res.json({ sheet: fms, steps: enrichedSteps });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// SHEET KA CHHOTA CACHE — Google ka quota bachane ke liye
// ══════════════════════════════════════════════════════
// FMS Tasks ka page khulte hi HAR step ke liye alag request jaati hai, aur
// har request POORI sheet padhti thi (A1:ZZ). PMS me 21 step hain -- yaani
// ek banda page khole to 21 baar poori sheet. Do-teen log ek saath khol dein
// to Google ka "read requests per minute" quota khatam.
//
// 19 Sep 2026 ko log me yahi mila:
//   "Quota exceeded for quota metric 'Read requests' and limit
//    'Read requests per minute per user' ... sheets.googleapis.com"
// Quota khatam hone par request fail hoti hai aur doer ko rows aati hi
// nahi -- screen par "All done!" dikh jaata hai jabki kaam pending hota hai.
//
// Ab sheet 30 second ke liye yaad rakhi jaati hai. 21 step ab 21 nahi, EK
// read me nipat jaate hain. 30 sec isliye ki sheet me kiya hua badlav
// bahut der tak purana na dikhe.
const _sheetCache = new Map();
const SHEET_CACHE_MS = 30 * 1000;
async function readSheetCached(d, spreadsheetId, range) {
  const key = `${spreadsheetId}|${range}`;
  const hit = _sheetCache.get(key);
  if (hit && (Date.now() - hit.at) < SHEET_CACHE_MS) return hit.rows;
  // Ek hi waqt par kai request aayein to sirf PEHLI Google ko jaaye, baaki
  // usi ka intezaar karein -- warna 21 request ek saath nikal jaatin.
  if (hit && hit.wait) return hit.wait;
  const p = withRetry(() => d.sheets.spreadsheets.values.get({ spreadsheetId, range }))
    .then(r => {
      const rows = r.data.values || [];
      _sheetCache.set(key, { rows, at: Date.now() });
      return rows;
    })
    .catch(e => { _sheetCache.delete(key); throw e; });
  _sheetCache.set(key, { wait: p, at: Date.now(), rows: (hit && hit.rows) || [] });
  return p;
}
// Sheet me kuch likhne ke baad cache purana ho jaata hai -- turant hata do,
// warna doer ko apna hi kiya hua Done 30 sec tak pending dikhta rehta.
function clearSheetCache(spreadsheetId) {
  for (const k of _sheetCache.keys()) {
    if (!spreadsheetId || k.startsWith(spreadsheetId + '|')) _sheetCache.delete(k);
  }
}

// ══════════════════════════════════════════════════════
// ONLINE FMS: "seedha Delivery" niyam + Manual Order (31 Oct 2026)
// ══════════════════════════════════════════════════════
// Order Entry par ye 4 cheezein bhar gayin (Date of Delivery, WhatsApp, Piece
// in Stock?, Website Order?) to order manufacturing (flow ke step 3-9) nahi
// jaata -- seedha Step 10 (Handover box for dispatch to Naresh) par aata hai.
// Steps aur columns NAAM se pehchaane jaate hain, isliye FMS Admin me step
// aage-peeche hon to bhi niyam chalta hai. Sheet me 4 me se koi column hi na
// ho to niyam band rehta hai (sab pehle jaisa).
const FMS_SKIP_RULES = [{
  match: /online/i,
  whenFilled: ['date of delivery', 'whatsapp', 'stock', 'website order'],
  skipSteps: ['process piece', 'follow up with vendor', 'piece rec', 'qc ghat', 'beading', 'give for qc', 'follow up for order']
}];
const fmsNorm = s => String(s || '').toLowerCase().replace(/recieved/g, 'received').replace(/[^a-z0-9]+/g, ' ').trim();
const fmsFilled = v => { const s = String(v == null ? '' : v).trim(); return s !== '' && s.toUpperCase() !== 'FALSE'; };
function fmsSkipPlan(fms, headers) {
  const rule = FMS_SKIP_RULES.find(r => r.match.test(fms.fms_name || ''));
  if (!rule) return null;
  const H = (headers || []).map(fmsNorm);
  const cols = rule.whenFilled.map(k => H.findIndex(h => h.includes(k)));
  if (cols.some(c => c < 0)) return null;
  const skip = new Set();
  fms.steps.forEach((s, i) => { const n = fmsNorm(s.stepName); if (rule.skipSteps.some(k => n.includes(k))) skip.add(i); });
  if (!skip.size) return null;
  // Skip ke baad wala pehla step (Step 10). Sheet me uska Planned pichhle
  // (skip hue) step ke Actual se banta hai, to wo khali hoga -- isliye is
  // row par wo step zabardasti "lagu" maana jaata hai.
  const target = Math.max(...skip) + 1;
  return { cols, skip, target: target < fms.steps.length ? target : -1 };
}
// Ye row "seedha Delivery" wali hai? (chaaron khaane bhare)
const fmsRowSkips = (plan, row) => !!plan && plan.cols.every(c => fmsFilled(row[c]));
// Planned khali = step lagu nahi -- upar wala niyam isse pehle lagta hai
function fmsStepRelevant(plan, row, s, si) {
  if (plan && fmsRowSkips(plan, row)) {
    if (plan.skip.has(si)) return false;
    if (si === plan.target) return true;
  }
  const p = colLetterToIdx(s.planCol || '');
  return p < 0 || String(row[p] || '').trim() !== '';
}
// Order Entry wala step (FMS Admin me naam "Order Entry")
const fmsEntryStepIdx = fms => fms.steps.findIndex(s => /order\s*entry/i.test(s.stepName || ''));
// Step ke extra-input columns (A, B…) -- doer sirf inhi me likh sakta hai
function fmsStepCols(step) {
  const set = new Set();
  (step.extraRows || []).forEach(r => {
    [r.col_letter, r.sub_col_letter].forEach(c => { const x = String(c || '').trim().toUpperCase(); if (x) set.add(x); });
  });
  return set;
}

// GET /api/fms-tasks/:fmsId/steps/:stepId/rows — fetch pending rows from external sheet
app.get('/api/fms-tasks/:fmsId/steps/:stepId/rows', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
    if (!fmsRow) return res.status(404).json({ error: 'FMS not found' });

    const fms = parseFMSRow(fmsRow);
    // Find current step index (0-based)
    const stepIdx = fms.steps.findIndex((s,i) => String(s.id || i+1) === String(req.params.stepId));
    // Pehle yahan khali list jaati thi, jo screen par "✅ All done!" dikhti
    // thi -- yaani config ki gadbad bilkul "kaam ho gaya" jaisi lagti thi.
    // Ab saaf error, taaki asli baat pata chale. (19 Sep 2026)
    if (stepIdx < 0) return res.status(404).json({ error: `Step ${req.params.stepId} is FMS me mila hi nahi — FMS Admin me step dobara save karo` });
    const step = fms.steps[stepIdx];

    const spreadsheetId = extractSheetId(fms.sheet_id);
    const headerRow = parseInt(fms.header_row) || 1;

    // Poori sheet — 30 sec ka cache, taaki 21 step ke liye 21 baar Google
    // ko na jaana pade (quota isi se khatam ho raha tha)
    const allRows = await readSheetCached(d, spreadsheetId, `${fms.sheet_name}!A1:ZZ`);
    if (allRows.length < headerRow) return res.json({ rows: [], headers: [], total: 0, allHeaders: [] });

    const headers = allRows[headerRow - 1] || [];
    const rawDataRows = allRows.slice(headerRow);

    const actualIdx = colLetterToIdx(step.actualCol || '');
    const planIdx   = colLetterToIdx(step.planCol   || '');

    // Determine first-column check range for "real data" (skip pure-checkbox/formula-only rows)
    const hasRealData = (row) => {
      const checkLen = Math.min(10, headers.length);
      for (let i = 0; i < checkLen; i++) {
        const v = (row[i] || '').trim();
        if (v && v.toUpperCase() !== 'FALSE' && v.toUpperCase() !== 'TRUE') return true;
      }
      return false;
    };

    // A value counts as "done" if it's non-empty and not FALSE (checkbox unchecked)
    const isDone = (val) => {
      const v = (val || '').trim();
      return v !== '' && v.toUpperCase() !== 'FALSE';
    };

    // Filter: real data row + row is relevant to THIS step + all relevant previous
    // steps done + current step pending.
    // "Relevant" = step ka planCol us row mein khali nahi hai. Kuch sheets mein (jaise
    // Sale Type = Store Visit / Customised) har row sirf EK step par lagu hoti hai —
    // Planned column sirf usi step ke liye bharta hai. Isliye jis step ka Planned
    // column is row mein khali hai, wo step us row par apply hi nahi hota (skip),
    // aur wo "previous step must be done" wali check ko bhi block nahi karega.
    //
    // 20 Sep 2026 -- EK BADI GADBAD YAHIN CHHUPI THI:
    // PMS sheet me Planned column (U) ka formula kaam karna band ho gaya tha
    // aur POORI sheet me wo khali ho gaya -- 766 me se EK bhi row me value
    // nahi. Upar wale niyam ke hisaab se har row "is step par lagu nahi"
    // ban gayi, saari rows chhup gayin, aur doer ko "✅ All done!" dikhne
    // laga jabki 766 kaam pade the. Kisi ko pata hi nahi chalta -- na error,
    // na warning.
    //
    // Isliye ab: agar kisi step ka Planned column POORI SHEET me khali hai,
    // to us step ke liye ye niyam lagta hi nahi -- wo har row par lagu maana
    // jaata hai. Matlab sheet ka formula bigad bhi jaye to kaam dikhta
    // rahega, chhupega nahi.
    // Jin sheets me Planned sach me per-step bharta hai (Store Visit /
    // Customised wali), wahan kuch nahi badla -- wahan column khali nahi
    // hota, to niyam pehle jaisa hi chalta hai.
    // 20 Sep 2026 -- pehle yahan ek "fallback" daala tha: Planned column poori
    // sheet me khali ho to us step ko har row par lagu maan lo. Wo GALAT nikla:
    // is sheet me step 2..20 ka Planned isliye khali hai ki wahan tak kaam
    // pahuncha hi nahi (har step ka Planned pichhle step ke Actual se banta
    // hai). Fallback ne un steps par 97 rows dikha di jinka kaam tha hi nahi.
    // Isliye niyam wapas sakht: Planned khali = ye step is row par lagu nahi.
    //
    // Par ASLI dikkat (kaam chhup jaana) chhupni nahi chahiye -- uska ilaaj
    // filter badalna nahi, BATANA hai. Niche planEmpty bhej rahe hain, jisse
    // screen par "All done!" ki jagah saaf wajah likhi aati hai.
    const planHasAny = {};
    fms.steps.forEach((s, i) => {
      const pi = colLetterToIdx(s.planCol || '');
      planHasAny[i] = pi >= 0 && rawDataRows.some(r => String(r[pi] || '').trim() !== '');
    });
    // Online FMS: 4 khaane bhare hon to step 3-9 lagu nahi, Step 10 lagu
    const skipPlan = fmsSkipPlan(fms, headers);
    const isRelevant = (row, s, si) => fmsStepRelevant(skipPlan, row, s, si);
    // Jis step ka ACTUAL column set hi nahi hai, uska "Done" kahin likha hi
    // nahi ja sakta -- wo step chal hi nahi sakta. Pehle aisa step HAR row ko
    // pending dikha deta tha (PMS ka Step-21 aise hi 97 phantom rows dikha
    // raha tha). Ab wahan koi row nahi, aur niche saaf likha jaata hai ki
    // column set karo. (20 Sep 2026)
    const pending = (colLetterToIdx(step.actualCol || '') < 0 ? [] : rawDataRows)
      .map((row, idx) => ({ row, sheetRow: headerRow + idx + 1 }))
      .filter(({ row }) => {
        if (!hasRealData(row)) return false;
        // Ye row is step par apply hi nahi hoti to yahan pending nahi dikhegi
        if (!isRelevant(row, step, stepIdx)) return false;
        // Sirf un previous steps ko "done hona chahiye" treat karo jo IS ROW par
        // relevant hain — jo step row par lagu hi nahi, wo block nahi karega
        for (let i = 0; i < stepIdx; i++) {
          const prevStep = fms.steps[i];
          if (!isRelevant(row, prevStep, i)) continue;
          const prevIdx = colLetterToIdx(prevStep.actualCol || '');
          if (prevIdx >= 0 && !isDone(row[prevIdx])) return false;
        }
        // Current step must be pending
        if (actualIdx < 0) return true;
        return !isDone(row[actualIdx]);
      });

    // Kaunse columns dikhane hain — HAMESHA column index ke saath.
    // Pehle yahan do gadbad thi aur data galat column me dikh jaata tha:
    //  1) header ke NAAM se index dhoondha jaata tha (headers.indexOf) — is
    //     sheet me PLANNED/ACTUAL/STATUS jaise naam kai baar aate hain, to
    //     hamesha PEHLE wale column ka data uth jaata tha.
    //  2) showCols jis kram me admin ne tick kiye the usi kram me aate hain,
    //     par headers sheet ke kram me — dono match na hon to values shift ho
    //     kar padosi column me chali jaati thin (Cash Amount me link, waghera).
    const showColsIdx = [...new Set((step.showCols || []).map(Number).filter(n => !isNaN(n) && n >= 0 && n < headers.length))]
      .sort((a, b) => a - b);
    const wantedIdx = showColsIdx.length > 0
      ? showColsIdx
      : headers.map((_, i) => i).filter(i => i !== actualIdx);   // actual col chhupa do

    // Ek jaise naam wale columns ko alag pehchan do, warna ek doosre ko
    // overwrite kar dete hain (data object me key ek hi banti hai)
    const seen = {};
    const cols = wantedIdx.map(idx => {
      const raw = String(headers[idx] || '').trim();
      let key = raw || `Col ${idxToColLetter(idx)}`;
      if (seen[key]) key = `${key} (${idxToColLetter(idx)})`;
      seen[key] = (seen[key] || 0) + 1;
      return { key, idx };
    });

    // Build response in format frontend expects: {sheetRowNumber, planValue, data:{...}}
    // Extra-input columns ki abhi ki value -- Done form me pehle se bhari
    // aati hai (Order Entry me WhatsApp waghera edit karne ke liye)
    const extraCols = [...fmsStepCols(step)];
    const rows = pending.map(({ row, sheetRow }) => {
      const data = {};
      cols.forEach(c => { data[c.key] = row[c.idx] !== undefined ? String(row[c.idx]) : ''; });
      const cells = {};
      extraCols.forEach(c => { const i = colLetterToIdx(c); if (i >= 0) cells[c] = String(row[i] == null ? '' : row[i]); });
      return {
        sheetRowNumber: sheetRow,
        planValue: planIdx >= 0 ? (row[planIdx] || '') : '',
        data, cells
      };
    });

    // Agar ek bhi row nahi mili to WAJAH bhi bhejo. Pehle sirf khali list
    // jaati thi aur screen par "✅ All done!" likh aata tha -- chahe kaam
    // sach me ho gaya ho, ya sheet ka Planned column khali reh gaya ho, ya
    // step ke column set hi na kiye hon. Teeno ek jaise dikhte the, isliye
    // 766 kaam chhupe rehne par bhi kisi ko pata nahi chala. (20 Sep 2026)
    // Row na mile to do alag-alag baatein hoti hain -- inhe ek jaisa dikhana
    // galat hai:
    //   emptyWhy  = ASLI GADBAD (column set nahi, ya PEHLE step ka Planned
    //               hi khali). Yahan peeli warning banti hai.
    //   emptyNote = NORMAL BAAT (aage ka step abhi apni baari ka intezaar kar
    //               raha hai). Yahan sirf halki si line, warning nahi.
    // 20 Sep: pehle "Planned khali" par HAR step (2..21) peeli warning dikha
    // raha tha -- 20 step par dar wali warning, jabki wo bilkul normal haal
    // hai (har step ka Planned pichhle step ke Actual se banta hai).
    let emptyWhy = '', emptyNote = '';
    if (!rows.length) {
      const noActual = colLetterToIdx(step.actualCol || '') < 0;
      const noPlan   = colLetterToIdx(step.planCol   || '') < 0;
      if (noActual)
        emptyWhy = `This step has no ACTUAL column set — "Done" cannot be saved anywhere. Open Step ${stepIdx + 1} in FMS Admin and pick an Actual column.`;
      else if (noPlan)
        emptyWhy = `This step has no PLAN column set — open Step ${stepIdx + 1} in FMS Admin and pick a Plan column.`;
      else if (!planHasAny[stepIdx]) {
        if (stepIdx === 0) {
          // PEHLA step -- iska Planned khali hai to kaam kabhi shuru hi nahi
          // hoga. Yahi wo haal tha jisme 766 kaam chhup gaye the.
          emptyWhy = `The Planned column (${step.planCol}) is empty for every row in the sheet, so no work can start here. Please check that column's formula in the sheet.`;
        } else {
          emptyNote = `Work hasn't reached this step yet. Rows will appear here automatically once the previous step is marked Done.`;
        }
      }
    }
    // Order Entry step par "Add Manual Order" ka button dikhana hai ya nahi
    const isEntry = stepIdx === fmsEntryStepIdx(fms);
    res.json({ rows, headers: cols.map(c => c.key), total: rows.length, allHeaders: headers, emptyWhy, emptyNote,
      isEntry, skipRule: !!skipPlan });
  } catch(err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — FMS sheet ko service account ke saath share karo';
    if (msg.includes('404')) msg = 'Sheet not found — FMS config mein Sheet ID/Tab check karo';
    res.status(500).json({ error: msg });
  }
});

// ══════════════════════════════════════════════════════
// FMS AUTO-NOTIFICATIONS
// ══════════════════════════════════════════════════════
// Rule: "jab COLUMN me ye VALUE ho, to us bande ko WhatsApp bhejo".
// Message me {D} jaise placeholder us row ke us column ki value se badal
// jaate hain — isliye naya rule banane ke liye code chhedna nahi padta.
// Har row par ek hi baar jaata hai (FMS_Notify_Log se dedup).

// "Hello {name}, ghat to be ordered — Bill No: {D}" -> asli values bhar do
// Ek cell me kai naam — dropdown me jitne tick kiye ("shivam, mona, monu
// bhaiya"). Comma / slash / newline / semicolon se todte hain. Space se NAHI,
// warna "Ravi bhaiya piroi" tut jaata.
function fmsSplitNames(raw) {
  const SEP = new RegExp('[,;/|\r\n]+');
  return String(raw == null ? '' : raw)
    .split(SEP)
    .map(x => x.trim())
    .filter(x => x && x.toUpperCase() !== 'FALSE');
}

function fmsFillTemplate(tpl, row, person) {
  return String(tpl || '').replace(/\{([A-Za-z]{1,3}|name)\}/g, (m, key) => {
    if (String(key).toLowerCase() === 'name') return person || '';
    const idx = colLetterToIdx(key);
    if (idx < 0) return m;
    return String(row[idx] == null ? '' : row[idx]).trim();
  }).trim();
}

// Rule ka match. Value khali ho to "kuch bhi bhara ho" maana jaata hai.
// Sheet me aksar poora vakya hota hai — "YES > Vendor Name, bappi ji" —
// isliye sirf exact match kaafi nahi. Cell us value se SHURU hota ho to bhi
// match maante hain, par sirf tab jab aage koi alag cheez ho (space, >, comma)
// taaki "YES" wala rule "YESTERDAY" par galti se na chale.
function fmsRuleMatches(cellRaw, matchValue) {
  const cell = String(cellRaw == null ? '' : cellRaw).trim();
  if (!cell || cell.toUpperCase() === 'FALSE') return false;
  const want = String(matchValue || '').trim();
  if (!want) return true;                                  // koi bhi value chalegi
  const c = cell.toLowerCase();
  // "Kavita|yes" jaisa likho to in me se koi bhi mile to match
  return want.split('|').map(x => x.trim()).filter(Boolean).some(one => {
    const w = one.toLowerCase();
    if (c === w) return true;                              // bilkul wahi
    // Poora shabd kahin bhi mile to match — "YES", "YES > Vendor Name",
    // "(Yes)", "ok yes" sab chalenge. Par "YESTERDAY" nahi (alag shabd hai).
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(c);
  });
}

// Usi Google Sheet me "Notification Log" tab — har bheje hue message ka
// record (bill no, kisko, kab, gaya ya nahi). Tab na ho to bana deta hai.
const FMS_LOG_TAB = 'Notification Log';
const FMS_LOG_HEADERS = ['Sent At (IST)', 'Bill No', 'To', 'Phone', 'Rule', 'Status', 'Message', 'Sheet Row'];

async function ensureNotifyLogTab(d, spreadsheetId) {
  try {
    const meta = await withRetry(() => d.sheets.spreadsheets.get({
      spreadsheetId, fields: 'sheets(properties(title))'
    }));
    const exists = (meta.data.sheets || []).some(s => s.properties.title === FMS_LOG_TAB);
    if (exists) return true;
    await withRetry(() => d.sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: FMS_LOG_TAB } } }] }
    }));
    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId, range: `${FMS_LOG_TAB}!A1:H1`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [FMS_LOG_HEADERS] }
    }));
    return true;
  } catch (e) {
    console.error('  Notification Log tab banane me dikkat:', e.message);
    return false;
  }
}

async function appendNotifyLog(d, spreadsheetId, rows) {
  if (!rows.length) return;
  try {
    await ensureNotifyLogTab(d, spreadsheetId);
    await withRetry(() => d.sheets.spreadsheets.values.append({
      spreadsheetId, range: `${FMS_LOG_TAB}!A:H`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows }
    }));
  } catch (e) {
    console.error('  Notification Log likhne me dikkat:', e.message);
  }
}

// Usi sheet ke "Notification" tab se naam -> number ki list. Number badalna ho
// to bas wahan badal do — code me kuch nahi karna. (A = Name, B = Number)
const FMS_DIR_TAB = 'Notification';
async function readNotifyDirectory(d, spreadsheetId) {
  const dir = {};
  try {
    const resp = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId, range: `${FMS_DIR_TAB}!A:B`
    }));
    for (const row of (resp.data.values || []).slice(1)) {   // pehli row heading
      const name = String((row && row[0]) || '').trim().toLowerCase();
      const phone = normalizePhone((row && row[1]) || '');
      if (name && phone) dir[name] = phone;
    }
  } catch (e) {
    console.error(`  "${FMS_DIR_TAB}" tab padhne me dikkat:`, e.message);
  }
  return dir;
}

let _fmsNotifyRunning = false;
async function runFMSNotifications(force) {
  // ⛔ ROKA HUA (Harsh, 20 Aug 2026): "PMS vala sheet vala message stop kr do
  // jab me bolunga tab bhejna." Delegation/checklist alert aur daily reminder
  // ispar bilkul asar nahi — wo alag flag (WA.enabled) se chalte hain, chalte
  // rahenge. Sirf sheet-based FMS/PMS notification rukega, jab tak
  // whatsapp.config.js me fmsNotifyEnabled wapas true na ho.
  if (!force && WA.fmsNotifyEnabled === false) return { skipped: 'fms-paused-by-harsh' };
  // Apne aap sirf live server par; admin ka "Abhi chala kar dekho" har jagah
  if (!force && !waAutoAllowed()) return { skipped: 'not-production' };
  if (!WA.enabled || !WA.url || !WA.apiKey) return { skipped: 'wa-not-configured' };
  if (_fmsNotifyRunning) return { skipped: 'already-running' };
  // Time ki koi rok nahi — sheet me value aate hi message jaata hai, chahe
  // jo bhi time ho (daily reminders wala 10:15/5:00 rule ispar lagu nahi).

  _fmsNotifyRunning = true;
  try {
    const d = await getDB();
    const rules = (await d.findAll('FMS_Notify_Rules')).filter(r => String(r.enabled) !== '0');
    if (!rules.length) return { rules: 0 };

    const sentLog = await d.findAll('FMS_Notify_Log');
    // Dedup ab HAR BANDE ka alag — ek hi row se kai logon ko message ja sakta
    // hai (jaise BEAD CHANGES: AB me jitne naam select honge, sabko jayega).
    // Purani entries me phone hai hi, isliye ye peeche se bhi theek chalta hai.
    const already = new Set(sentLog.map(l => `${l.rule_id}|${l.sheet_row}|${l.phone}`));
    const byFms = {};
    for (const r of rules) (byFms[String(r.fms_id)] = byFms[String(r.fms_id)] || []).push(r);

    let sent = 0, failed = 0;
    for (const fmsId of Object.keys(byFms)) {
      const fmsRow = await d.findOne('FMS_Config', { id: String(fmsId) });
      if (!fmsRow) continue;
      const fms = parseFMSRow(fmsRow);
      let allRows;
      try {
        // Wahi cache — notify har 3 min chalta hai aur poori sheet padhta
        // hai; isse doer ke request ke saath quota nahi tootta
        allRows = await readSheetCached(d, extractSheetId(fms.sheet_id), `${fms.sheet_name}!A1:ZZ`);
      } catch (e) { console.error('  FMS notify — sheet read failed:', fms.sheet_name, e.message); continue; }

      const headerRow = parseInt(fms.header_row) || 1;
      const dataRows = allRows.slice(headerRow);
      const sheetLogRows = [];   // isi sheet ke "Notification Log" tab ke liye
      // Number hamesha sheet ke Notification tab se — wahan badla to yahan bhi
      const dir = await readNotifyDirectory(d, extractSheetId(fms.sheet_id));

      for (const rule of byFms[fmsId]) {
        const colIdx = colLetterToIdx(rule.watch_col || '');
        if (colIdx < 0) continue;
        const billIdx = colLetterToIdx(rule.bill_col || 'D');
        // person_col set ho to har row me alag banda — us column me jiska naam
        // likha hoga usi ko message jayega (jaise beads wala: AB me Mona/Monu/
        // Shivam me se jo bhi likha ho). Warna rule ka fixed person.
        const personIdx = colLetterToIdx(rule.person_col || '');

        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i] || [];
          const sheetRow = headerRow + i + 1;
          if (!fmsRuleMatches(row[colIdx], rule.match_value)) continue;

          // Ek cell me KAI naam ho sakte hain — dropdown me jitne tick kiye,
          // sab comma/slash se alag hokar aate hain (jaise "shivam, mona").
          // Sabko alag-alag message jayega.
          const rawPerson = personIdx >= 0
            ? String(row[personIdx] || '').trim()
            : String(rule.person || '').trim();
          if (!rawPerson) continue;                        // kiska naam hi nahi
          const people = fmsSplitNames(rawPerson);
          if (!people.length) continue;

          for (const person of people) {
            // Number hamesha sheet ke Notification tab se; fixed-person rule me
            // naam na mile to rule ka saved number fallback
            const phone = dir[person.toLowerCase()] || (personIdx >= 0 ? '' : normalizePhone(rule.phone));
            if (!phone) continue;                          // is naam ka number nahi mila
            const perKey = `${rule.id}|${sheetRow}|${phone}`;
            if (already.has(perKey)) continue;             // is bande ko bhej chuke

            const text = fmsFillTemplate(rule.message, row, person);
            if (!text) continue;
            // Log PEHLE likho — bhejte waqt app restart ho jaye to bhi duplicate
            // na jaaye (ek missed message duplicate se behtar hai)
            already.add(perKey);
            const nowIst = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);
            await d.insert('FMS_Notify_Log', {
              rule_id: String(rule.id), sheet_row: String(sheetRow), phone,
              sent_at: nowIst
            });
            // Outbox se — pehle seedha bhejte the, to Aumpfy fail karta to message
            // hamesha ke liye gum ho jaata tha aur dobara koshish bhi nahi hoti thi.
            // Ab fail ho to apne aap retry hota hai.
            const r = await queueWhatsApp(phone, text, 'fms-notify', `${rule.id}:${sheetRow}`, person);
            const ok = !!r;
            if (ok) sent++;
            else { failed++; console.error(`  FMS notify queue fail — ${person} (${phone}) row ${sheetRow}`); }
            sheetLogRows.push([
              nowIst,
              billIdx >= 0 ? String(row[billIdx] == null ? '' : row[billIdx]).trim() : '',
              person,
              phone,
              `COL ${rule.watch_col} = ${rule.match_value || '(kuch bhi)'}`,
              ok ? '✅ Sent' : '❌ Failed',
              text,
              String(sheetRow)
            ]);
          }
        }
      }
      // Sab bhejne ke baad ek hi baar sheet me likho (har message par nahi)
      await appendNotifyLog(d, extractSheetId(fms.sheet_id), sheetLogRows);
    }
    if (sent || failed) console.log(`  FMS notifications: ${sent} sent, ${failed} failed`);
    return { sent, failed, rules: rules.length };
  } catch (err) {
    console.error('  runFMSNotifications error:', err.message);
    return { error: err.message };
  } finally {
    _fmsNotifyRunning = false;
  }
}

// Pehli baar ke rules apne aap bana do — user ko UI me kuch bharna na pade.
// Sirf tab banta hai jab wahi rule pehle se na ho, isliye restart par duplicate
// nahi bante. Baad me user UI se edit/pause/delete kar sakta hai.
const FMS_SEED_RULES = [
  // Z = GHAT TO BE ORDERED
  { fmsName: 'pms', watch_col: 'Z', match_value: 'Yes', person: 'PM',
    phone: '9516896449', bill_col: 'D',
    message: 'Hello {name}, ghat to be ordered — Bill No: {D}' },
  // AF = NATH
  { fmsName: 'pms', watch_col: 'AF', match_value: 'Yes', person: 'Ashok Sn',
    phone: '9868511955', bill_col: 'D',
    message: 'Hello {name}, nath order — Bill No: {D}' },
  // AC = CAD/ CAM REQUIRED — jiska naam likha ho usi ko jaata hai
  { fmsName: 'pms', watch_col: 'AC', match_value: 'Jagrati', person: 'Jagrati',
    phone: '9217566771', bill_col: 'D',
    message: 'Hello {name}, Cad/ Cam makeing — Bill No: {D}' },
  { fmsName: 'pms', watch_col: 'AC', match_value: 'Ravi Kant', person: 'Ravi Kant',
    phone: '9217414222', bill_col: 'D',
    message: 'Hello {name}, Cad/ Cam makeing — Bill No: {D}' },
  // AK = Vendor — koi bhi naam ho to Bappi ko, vendor ka naam bhi saath me
  { fmsName: 'pms', watch_col: 'AK', match_value: '', person: 'Bappi',
    phone: '8076802603', bill_col: 'D',
    message: 'Hello {name}, vendor: {AK} — Bill No: {D}' },
  // AG = CHOODA COVER — "Kavita" ya "yes", dono me se kuch bhi ho
  { fmsName: 'pms', watch_col: 'AG', match_value: 'Kavita|yes', person: 'Kavita',
    phone: '9211567771', bill_col: 'D',
    message: 'Hello {name}, Chooda / chooda cover plz order — Bill No: {D}' },
  // AA = BEAD CHANGES me "Yes" -> AB (STOCK OF BEADS) me jitne naam tick kiye
  // hon, UN SABKO jaata hai (Mona / Monu / Ravi bhaiya piroi / Shivam)
  { fmsName: 'pms', watch_col: 'AA', match_value: 'Yes', person: '', person_col: 'AB',
    phone: '', bill_col: 'D',
    message: 'Hello {name}, plz check beads are availabe or not if not available so plz order by Ashok Sn and also change the bead of this order — Bill No: {D}' },
  // DA = Step-18 ka Actual — date aate hi (step 18 done) Bajji ko shoot ka
  { fmsName: 'pms', watch_col: 'DA', match_value: '', person: 'Bajji',
    phone: '8595738403', bill_col: 'D',
    message: 'Hello {name}, plz shoot for this order — Bill No: {D}' },
  // DL = "delivery status updated by sales person" — kuch bhi likhe to Naresh
  // ko porter booking ka, poori details + contact (DM) + bill ke saath
  { fmsName: 'pms', watch_col: 'DL', match_value: '', person: 'Naresh',
    phone: '9810479397', bill_col: 'D',
    message: 'Hello {name}, porter booking — {DL} | Contact: {DM} | Bill No: {D}' }
];

// AA (BEAD CHANGES) ka rule pehle "No" par tha; Harsh ne 20 Aug ko badla —
// ab "Yes" par jaana hai. Seeding sirf naye rule banati hai, purane ko haath
// nahi lagati, isliye yahan seedha update karte hain.
async function fixBeadRuleToYes() {
  const MARKER = 'fms_bead_rule_no_to_yes_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const rules = await d.findAll('FMS_Notify_Rules').catch(() => []);
    let fixed = 0;
    for (const r of rules) {
      if (String(r.watch_col || '').toUpperCase() !== 'AA') continue;
      if (String(r.match_value || '').trim().toLowerCase() !== 'no') continue;
      await d.update('FMS_Notify_Rules', r.id, { match_value: 'Yes', person_col: 'AB', person: '' });
      fixed++;
    }
    await d.insert('App_State', {
      key_name: MARKER, value: `fixed ${fixed}`,
      updated_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    if (fixed) console.log(`  ✅ BEAD CHANGES rule ab "Yes" par (${fixed} rule)`);
  } catch (e) {
    console.error('  fixBeadRuleToYes error:', e.message);
  }
}

async function seedFMSNotifyRules() {
  try {
    const d = await getDB();
    const [allFms, existing] = await Promise.all([
      d.findAll('FMS_Config').catch(() => []),
      d.findAll('FMS_Notify_Rules').catch(() => [])
    ]);
    if (!allFms.length) return;
    for (const seed of FMS_SEED_RULES) {
      const fms = allFms.find(f => String(f.fms_name || f.sheet_name || '').toLowerCase().includes(seed.fmsName));
      if (!fms) continue;
      const dup = existing.some(r =>
        String(r.fms_id) === String(fms.id) &&
        String(r.watch_col || '').toUpperCase() === seed.watch_col &&
        String(r.match_value || '') === String(seed.match_value || ''));
      if (dup) continue;
      await d.insert('FMS_Notify_Rules', {
        fms_id: String(fms.id), watch_col: seed.watch_col, match_value: seed.match_value,
        person: seed.person, phone: seed.phone, message: seed.message,
        bill_col: seed.bill_col, person_col: seed.person_col || '', enabled: '1',
        created_at: new Date().toISOString().replace('T', ' ').split('.')[0]
      });
      console.log(`  Notify rule seeded: ${fms.fms_name || fms.sheet_name} COL ${seed.watch_col}=${seed.match_value} -> ${seed.person}`);
    }
  } catch (e) {
    console.error('  seedFMSNotifyRules error:', e.message);
  }
}

// ── Rules CRUD (admin) ──
app.get('/api/fms-notify/:fmsId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    const rules = (await d.findAll('FMS_Notify_Rules'))
      .filter(r => String(r.fms_id) === String(req.params.fmsId))
      .map(r => ({
        id: parseInt(r.id), watchCol: r.watch_col, matchValue: r.match_value,
        person: r.person, phone: r.phone, message: r.message,
        billCol: r.bill_col || 'D', personCol: r.person_col || '',
        enabled: String(r.enabled) !== '0'
      }));
    const log = await d.findAll('FMS_Notify_Log');
    const counts = {};
    for (const l of log) counts[l.rule_id] = (counts[l.rule_id] || 0) + 1;
    rules.forEach(r => { r.sentCount = counts[String(r.id)] || 0; });
    res.json({ rules });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fms-notify/:fmsId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { watchCol, matchValue, person, phone, message, billCol, personCol } = req.body || {};
    if (!String(watchCol || '').trim()) return res.status(400).json({ error: 'Column chahiye (jaise Z)' });
    if (!normalizePhone(phone)) return res.status(400).json({ error: 'Sahi phone number daalo' });
    if (!String(message || '').trim()) return res.status(400).json({ error: 'Message likho' });
    const d = await getDB();
    const saved = await d.insert('FMS_Notify_Rules', {
      fms_id: String(req.params.fmsId), watch_col: String(watchCol).trim().toUpperCase(),
      match_value: String(matchValue || '').trim(), person: String(person || '').trim(),
      phone: String(phone).trim(), message: String(message).trim(),
      bill_col: String(billCol || 'D').trim().toUpperCase() || 'D',
      person_col: String(personCol || '').trim().toUpperCase(), enabled: '1',
      created_at: new Date().toISOString().replace('T', ' ').split('.')[0]
    });
    res.json({ success: true, id: parseInt(saved.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/fms-notify/rule/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    const upd = {};
    if (req.body.enabled !== undefined) upd.enabled = req.body.enabled ? '1' : '0';
    ['watchCol', 'matchValue', 'person', 'phone', 'message', 'billCol', 'personCol'].forEach(k => {
      if (req.body[k] === undefined) return;
      const col = { watchCol: 'watch_col', matchValue: 'match_value', person: 'person', phone: 'phone', message: 'message', billCol: 'bill_col', personCol: 'person_col' }[k];
      upd[col] = ['watchCol','billCol','personCol'].includes(k) ? String(req.body[k]).trim().toUpperCase() : String(req.body[k]).trim();
    });
    if (Object.keys(upd).length) await d.update('FMS_Notify_Rules', req.params.id, upd);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/fms-notify/rule/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    await d.delete('FMS_Notify_Rules', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Abhi chala kar dekho (admin) — kitne gaye, kitne fail
app.post('/api/fms-notify/run', requireAuth, requireAdmin, async (req, res) => {
  const r = await runFMSNotifications(true);   // manual — dev par bhi chale
  res.json(r || {});
});

// GET /api/fms-tracking/:fmsId — har data row ka poora safar: kaunse step tak
// pahunchi, abhi kis step par atki hai, uska doer kaun hai. FMS Tracking
// dashboard isi se banta hai.
app.get('/api/fms-tracking/:fmsId', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
    if (!fmsRow) return res.status(404).json({ error: 'FMS not found' });
    const fms = parseFMSRow(fmsRow);
    if (!fms.steps.length) return res.json({ steps: [], rows: [] });

    // Sirf utne hi columns padho jitne chahiye (A1:ZZ = 700+ columns, bade
    // sheet par response bhaari ho jaata hai aur adhura aa sakta hai)
    let lastCol = 8;   // pehle 8 columns entry ki pehchan ke liye
    for (const s of fms.steps) {
      lastCol = Math.max(lastCol, colLetterToIdx(s.planCol || '') + 1, colLetterToIdx(s.actualCol || '') + 1);
      // Order Entry ke 4 khaane bhi chahiye ("seedha Delivery" niyam ke liye)
      for (const c of fmsStepCols(s)) lastCol = Math.max(lastCol, colLetterToIdx(c) + 1);
    }
    // Niyam wale khaane kisi step me set na hon to bhi sheet ke shuru ke
    // 30 columns me milne chahiye
    if (FMS_SKIP_RULES.some(r => r.match.test(fms.fms_name || ''))) lastCol = Math.max(lastCol, 30);
    const endCol = idxToColLetter(Math.max(7, lastCol - 1));

    const [allUsers, response] = await Promise.all([
      d.findAll('Users'),
      withRetry(() => d.sheets.spreadsheets.values.get({
        spreadsheetId: extractSheetId(fms.sheet_id), range: `${fms.sheet_name}!A1:${endCol}`
      }))
    ]);
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u.name || '';

    const headerRow = parseInt(fms.header_row) || 1;
    const allRows = response.data.values || [];
    const headers = allRows[headerRow - 1] || [];
    const dataRows = allRows.slice(headerRow);

    const isDone = v => { const s = String(v || '').trim(); return s !== '' && s.toUpperCase() !== 'FALSE'; };
    // Wahi rule jo pending-rows endpoint me hai: jis step ka Planned column
    // is row me khali hai, wo step is row par lagu hi nahi hota.
    // (Online FMS ka "seedha Delivery" niyam bhi yahi lagta hai)
    const skipPlan = fmsSkipPlan(fms, headers);
    const isRelevant = (row, s, si) => fmsStepRelevant(skipPlan, row, s, si);
    const hasRealData = row => {
      for (let i = 0; i < Math.min(10, headers.length); i++) {
        const v = String(row[i] || '').trim();
        if (v && v.toUpperCase() !== 'FALSE' && v.toUpperCase() !== 'TRUE') return true;
      }
      return false;
    };

    const stepMeta = fms.steps.map((s, i) => ({
      id: s.id || i + 1, order: i + 1, name: s.stepName || `Step ${i + 1}`,
      doers: (Array.isArray(s.doers) ? s.doers : []).map(uid => userMap[String(uid)] || String(uid)).filter(Boolean)
    }));

    // Row ki pehchan ke liye pehle 8 columns (Timestamp, Name, Phone, Bill…).
    // Naam ek jaise hon to unhe alag pehchan do, warna ek doosre ko overwrite
    // kar dete hain aur data galat column me dikhta hai.
    const seenLbl = {};
    const labelCols = headers.slice(0, 8).map((h, i) => {
      let name = String(h || '').trim() || `Col ${idxToColLetter(i)}`;
      if (seenLbl[name]) name = `${name} (${idxToColLetter(i)})`;
      seenLbl[name] = (seenLbl[name] || 0) + 1;
      return { name, idx: i };
    });

    const rows = [];
    dataRows.forEach((row, i) => {
      if (!hasRealData(row)) return;
      const per = [];
      let current = null, doneCount = 0, applicable = 0;
      fms.steps.forEach((s, si) => {
        const rel = isRelevant(row, s, si);
        const aIdx = colLetterToIdx(s.actualCol || '');
        const done = rel && aIdx >= 0 && isDone(row[aIdx]);
        if (rel) { applicable++; if (done) doneCount++; }
        per.push({
          order: si + 1, name: stepMeta[si].name,
          state: !rel ? 'na' : done ? 'done' : 'pending',
          actual: (rel && aIdx >= 0) ? String(row[aIdx] || '').trim() : '',
          planned: (() => { const p = colLetterToIdx(s.planCol || ''); return p >= 0 ? String(row[p] || '').trim() : ''; })()
        });
        // Pehla relevant + pending step = abhi yahan atki hai
        if (!current && rel && !done) current = { order: si + 1, name: stepMeta[si].name, doers: stepMeta[si].doers, planned: per[si].planned };
      });
      const data = {};
      labelCols.forEach(c => { data[c.name] = String(row[c.idx] || '').trim(); });
      rows.push({
        sheetRow: headerRow + i + 1, data, steps: per,
        currentStep: current, doneCount, applicable,
        complete: applicable > 0 && doneCount === applicable,
        direct: fmsRowSkips(skipPlan, row)     // manufacturing chhod kar seedha Delivery
      });
    });

    res.json({ fmsName: fms.fms_name || fms.sheet_name, steps: stepMeta, labelCols: labelCols.map(c => c.name), rows });
  } catch (err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — FMS sheet ko service account ke saath share karo';
    if (msg.includes('404')) msg = 'Sheet not found — FMS config me Sheet ID/Tab check karo';
    res.status(500).json({ error: msg });
  }
});

// POST /api/fms-tasks/:fmsId/steps/:stepId/done — mark step done in external sheet
app.post('/api/fms-tasks/:fmsId/steps/:stepId/done', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
    if (!fmsRow) return res.status(404).json({ error: 'FMS not found' });

    const fms = parseFMSRow(fmsRow);
    const stepIdx = fms.steps.findIndex((s,i) => String(s.id || i+1) === String(req.params.stepId));
    if (stepIdx < 0) return res.status(404).json({ error: 'Step not found' });
    const step = fms.steps[stepIdx];

    const { rowIndex, actualValue, delayReason, doerName, extraFields } = req.body;
    if (!rowIndex) return res.status(400).json({ error: 'rowIndex required' });

    // Sirf us step ka doer (ya admin) -- screen par bhi step usi ko dikhta hai
    if (req.session.role !== 'admin' && !(Array.isArray(step.doers) ? step.doers : []).map(String).includes(String(req.session.userId)))
      return res.status(403).json({ error: 'Ye step aapko assign nahi hai' });

    // Doer sirf apne step ke columns me likh sakta hai (FMS Admin me us step
    // ke extra-input columns). Pehle browser jo bhi column bhejta, wahi likh
    // jaata -- Order Entry ka doer online order ka koi bhi khaana badal sakta tha.
    if (Array.isArray(extraFields) && extraFields.length) {
      const allowed = fmsStepCols(step);
      const bad = extraFields.map(ef => String((ef && ef.col) || '').trim().toUpperCase()).filter(c => c && !allowed.has(c));
      if (bad.length) return res.status(400).json({ error: `Column ${bad.join(', ')} is step me edit nahi ho sakta` });
    }

    const spreadsheetId = extractSheetId(fms.sheet_id);
    const updates = [];

    // ══════════════════════════════════════════════════════
    // KHALI VALUE KABHI MAT LIKHO -- ye data mita deti thi
    // ══════════════════════════════════════════════════════
    // Harsh (23 Sep 2026): "PMS sheet me data auto delete ho raha hai, kal
    // ki entries gayab ho gayin."
    //
    // Wajah: Done form me jo OPTIONAL field khali chhod diya jaata tha, wo
    // bhi "" ban kar sheet me likh diya jaata tha. Sheet me us cell me pehle
    // se kuch likha ho (kisi ne haath se bhara ho, ya pichhle step me bhara
    // ho) to wo "" usko MITA deta tha. Row nahi udti thi -- cell khali ho
    // jaata tha, isliye "data apne aap delete ho gaya" lagta tha.
    //
    // Ab khali value ka matlab hai "is khaane ko haath mat lagao". Cell
    // saaf karna ho to sheet me khud karo -- app kabhi apne aap nahi mitayegi.
    const bhara = v => v !== undefined && v !== null && String(v).trim() !== '';

    if (step.actualCol && bhara(actualValue)) {
      updates.push({ range: `${fms.sheet_name}!${step.actualCol.toUpperCase()}${rowIndex}`, values: [[actualValue]] });
    }
    if (step.delayReasonCol && bhara(delayReason)) {
      updates.push({ range: `${fms.sheet_name}!${step.delayReasonCol.toUpperCase()}${rowIndex}`, values: [[delayReason]] });
    }
    if (step.doerNameCol && bhara(doerName)) {
      updates.push({ range: `${fms.sheet_name}!${step.doerNameCol.toUpperCase()}${rowIndex}`, values: [[doerName]] });
    }
    const generatedIds = {};
    if (extraFields && Array.isArray(extraFields)) {
      for (const ef of extraFields) {
        if (!ef.col) continue;
        let val = ef.value;
        // Unique ID: number SERVER par banta hai (browser par nahi) — do doer
        // ek saath Done karein to bhi ek hi ID do baar nahi milti.
        if (ef.auto === 'uniqid') {
          const colIdx = colLetterToIdx(ef.col);
          const prefix = String(ef.prefix || 'UQ').trim() || 'UQ';
          const pad = Math.min(8, Math.max(1, parseInt(ef.pad) || 3));
          let existing = [];
          try {
            const colResp = await withRetry(() => d.sheets.spreadsheets.values.get({
              spreadsheetId, range: `${fms.sheet_name}!${ef.col.toUpperCase()}:${ef.col.toUpperCase()}`
            }));
            existing = (colResp.data.values || []).map(r => (r && r[0]) || '');
          } catch (e) { existing = []; }
          val = nextUniqId(existing, prefix, pad);
          generatedIds[ef.col.toUpperCase()] = val;
        }
        // Wahi niyam extra fields par bhi: khali chhoda hua khaana sheet ka
        // purana data nahi mitayega. (auto-ID hamesha bhari hoti hai)
        if (bhara(val)) {
          updates.push({ range: `${fms.sheet_name}!${ef.col.toUpperCase()}${rowIndex}`, values: [[val]] });
        }
      }
    }

    if (updates.length > 0) {
      await withRetry(() => d.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
      }));
    }

    // Sheet badal gayi -- cache turant hatao, warna doer ko apna hi kiya hua
    // Done 30 second tak pending dikhta rehta
    clearSheetCache(spreadsheetId);

    res.json({ success: true, generatedIds });
  } catch(err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — sheet ko service account ke saath Editor access de';
    res.status(500).json({ error: msg });
  }
});

// ══════════════════════════════════════════════════════
// MANUAL ORDER (Online FMS, Step 1 Order Entry) -- 13 khaane, sab zaroori
// ══════════════════════════════════════════════════════
// Online (API) order sheet me khud aate hain; jo order team haath se leti hai
// wo yahan se FMS tab me NAYI ROW ban kar jaata hai. Column sheet ke header
// ke NAAM se milte hain (pehle bilkul same naam, phir "naam me shaamil").
const FMS_MANUAL_FIELDS = [
  { key: 'poOrder',  label: 'PO / Order number', names: ['po order number', 'order number', 'po order no'] },
  { key: 'dod',      label: 'Date of Delivery', type: 'date', names: ['date of delivery', 'delivery date'] },
  { key: 'timestamp', label: 'Timestamp', type: 'auto', names: ['timestamp'] },
  { key: 'po',       label: 'PO number', names: ['po number', 'po no'] },
  { key: 'party',    label: 'Party Name', names: ['party name', 'party'] },
  { key: 'email',    label: 'Email', type: 'email', names: ['email', 'email id'] },
  { key: 'phone',    label: 'WhatsApp Phone Number', type: 'tel', names: ['whatsapp phone number', 'whatsapp'] },
  { key: 'billing',  label: 'Billing Address', type: 'textarea', names: ['billing address'] },
  { key: 'shipping', label: 'Shipping Address', type: 'textarea', names: ['shipping address'] },
  { key: 'qty',      label: 'Total Qty', type: 'number', names: ['total qty', 'total quantity', 'qty'] },
  { key: 'photo',    label: 'Order Photo', type: 'image', names: ['order photo', 'photo'] },
  { key: 'stock',    label: 'Piece in Stock ?', type: 'yesno', names: ['piece in stock', 'in stock', 'stock'] },
  { key: 'website',  label: 'Website Order?', type: 'yesno', names: ['website order'] }
];
// Har field ka column (index) -- ek column do field ko nahi milta
function fmsManualMap(headers) {
  const H = (headers || []).map(fmsNorm), used = new Set(), map = {};
  for (const f of FMS_MANUAL_FIELDS) {
    let idx = -1;
    for (const n of f.names) { idx = H.findIndex((h, i) => !used.has(i) && h === n); if (idx >= 0) break; }
    if (idx < 0) for (const n of f.names) { idx = H.findIndex((h, i) => !used.has(i) && h.includes(n)); if (idx >= 0) break; }
    if (idx >= 0) used.add(idx);
    map[f.key] = idx;
  }
  const srcIdx = H.findIndex((h, i) => !used.has(i) && (h === 'order source' || h === 'source'));
  return { map, srcIdx, missing: FMS_MANUAL_FIELDS.filter(f => map[f.key] < 0).map(f => f.label) };
}
// FMS, uska Order Entry step, aur kya ye banda use chala sakta hai
async function fmsManualCtx(req) {
  const d = await getDB();
  const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
  if (!fmsRow) return { status: 404, error: 'FMS not found' };
  const fms = parseFMSRow(fmsRow);
  const ei = fmsEntryStepIdx(fms);
  if (ei < 0) return { status: 400, error: 'Is FMS me "Order Entry" naam ka step nahi hai — FMS Admin me pehla step "Order Entry" banao' };
  const step = fms.steps[ei];
  if (req.session.role !== 'admin' && !(Array.isArray(step.doers) ? step.doers : []).map(String).includes(String(req.session.userId)))
    return { status: 403, error: 'Order Entry aapko assign nahi hai' };
  return { d, fms, step, spreadsheetId: extractSheetId(fms.sheet_id), headerRow: parseInt(fms.header_row) || 1 };
}
const fmsManualErr = (res, err) => {
  let msg = err.message || 'Unknown error';
  if (msg.includes('403')) msg = 'Access denied — sheet ko service account ke saath Editor access do';
  if (msg.includes('404')) msg = 'Sheet not found — FMS config me Sheet ID/Tab check karo';
  res.status(500).json({ error: msg });
};

// GET — form ke khaane + sheet me kaunse column nahi mile
app.get('/api/fms-tasks/:fmsId/manual-order', requireAuth, async (req, res) => {
  try {
    const c = await fmsManualCtx(req);
    if (c.error) return res.status(c.status).json({ error: c.error });
    const all = await readSheetCached(c.d, c.spreadsheetId, `${c.fms.sheet_name}!A${c.headerRow}:ZZ${c.headerRow}`);
    const m = fmsManualMap(all[0] || []);
    res.json({ fields: FMS_MANUAL_FIELDS.map(({ key, label, type }) => ({ key, label, type: type || 'text' })), missing: m.missing });
  } catch (err) { fmsManualErr(res, err); }
});

// POST — naya manual order FMS tab me nayi row
app.post('/api/fms-tasks/:fmsId/manual-order', requireAuth, async (req, res) => {
  try {
    const c = await fmsManualCtx(req);
    if (c.error) return res.status(c.status).json({ error: c.error });
    const { d, fms, step, spreadsheetId, headerRow } = c;
    const body = (req.body && req.body.order) || {};

    // Sab zaroori -- koi khaana khali nahi
    const val = {};
    for (const f of FMS_MANUAL_FIELDS) {
      if (f.type === 'auto') continue;
      const v = String(body[f.key] == null ? '' : body[f.key]).trim();
      if (!v) return res.status(400).json({ error: `"${f.label}" bharna zaroori hai` });
      if (f.type === 'date') {
        const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return res.status(400).json({ error: `"${f.label}" ki date galat hai` });
        val[f.key] = `${m[3]}/${m[2]}/${m[1]}`;          // sheet jaisa dd/mm/yyyy
        continue;
      }
      if (f.type === 'tel' && !/^\+?\d{10,13}$/.test(v.replace(/[\s-]/g, '')))
        return res.status(400).json({ error: `"${f.label}" me 10 digit ka number daalo` });
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
        return res.status(400).json({ error: `"${f.label}" sahi email nahi hai` });
      if (f.type === 'number' && !(parseFloat(v) > 0))
        return res.status(400).json({ error: `"${f.label}" 0 se zyada hona chahiye` });
      if (f.type === 'yesno' && !['Yes', 'No'].includes(v))
        return res.status(400).json({ error: `"${f.label}" me Yes ya No chuno` });
      if (f.type === 'image' && !/^https?:\/\//i.test(v))
        return res.status(400).json({ error: `"${f.label}" ki photo upload karo` });
      val[f.key] = f.type === 'tel' ? v.replace(/[\s-]/g, '') : v;
    }
    val.timestamp = fmsEntryTimestamp();

    // Poori sheet (header, aakhri row, formulas) -- formula wale columns nayi
    // row me copy karne hain, warna aage ke steps ka Planned nahi banega
    const tab = fms.sheet_name;
    const [meta, valResp, fResp] = await Promise.all([
      withRetry(() => d.sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title,sheetId,gridProperties(rowCount,columnCount)))' })),
      withRetry(() => d.sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:ZZ` })),
      withRetry(() => d.sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:ZZ`, valueRenderOption: 'FORMULA' }))
    ]);
    const sh = (meta.data.sheets || []).find(s => s.properties.title === tab);
    if (!sh) return res.status(404).json({ error: `Sheet me "${tab}" tab nahi mila` });
    const all = valResp.data.values || [], fAll = fResp.data.values || [];
    const headers = all[headerRow - 1] || [];
    const m = fmsManualMap(headers);
    if (m.missing.length) return res.status(400).json({ error: `Sheet me ye columns nahi mile: ${m.missing.join(', ')}` });

    // Aakhri ASLI row (FALSE/TRUE wale checkbox data nahi) -- wahi naqsha bhi
    const isReal = r => (r || []).slice(0, 10).some(v => { const s = String(v || '').trim().toUpperCase(); return s && s !== 'FALSE' && s !== 'TRUE'; });
    let last = -1;
    for (let i = headerRow; i < all.length; i++) if (isReal(all[i])) last = i;
    const newRow = (last >= 0 ? last : headerRow - 1) + 2;           // 1-based
    const grid = sh.properties.gridProperties || {};
    if (grid.rowCount && newRow > grid.rowCount) {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ appendDimension: {
        sheetId: sh.properties.sheetId, dimension: 'ROWS', length: newRow - grid.rowCount + 100 } }] } }));
    }

    // Likhne wale khaane: 13 field + Order Entry ka Actual + Source
    const cells = {};
    for (const f of FMS_MANUAL_FIELDS) cells[m.map[f.key]] = f.type === 'date' || f.type === 'auto' ? val[f.key] : sheetSafeText(val[f.key]);
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    const today = `${String(now.getUTCDate()).padStart(2, '0')}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${now.getUTCFullYear()}`;
    const aIdx = colLetterToIdx(step.actualCol || '');
    if (aIdx >= 0 && cells[aIdx] === undefined) cells[aIdx] = today;
    if (m.srcIdx >= 0) cells[m.srcIdx] = 'Manual';

    // Upar wali row ke SIRF formula cells copy (value wale nahi -- warna
    // pichhle order ke Actual bhi aa jaate aur naya order "done" dikhta)
    const reqs = [];
    if (last >= 0) {
      const fr = fAll[last] || [];
      const width = Math.min(Math.max(headers.length, fr.length), grid.columnCount || 702);
      let s = -1;
      for (let ci = 0; ci <= width; ci++) {
        const isF = ci < width && cells[ci] === undefined && /^=/.test(String(fr[ci] == null ? '' : fr[ci]));
        if (isF && s < 0) s = ci;
        if (!isF && s >= 0) {
          reqs.push({ copyPaste: {
            source: { sheetId: sh.properties.sheetId, startRowIndex: last, endRowIndex: last + 1, startColumnIndex: s, endColumnIndex: ci },
            destination: { sheetId: sh.properties.sheetId, startRowIndex: newRow - 1, endRowIndex: newRow, startColumnIndex: s, endColumnIndex: ci },
            pasteType: 'PASTE_FORMULA' } });
          s = -1;
        }
      }
    }
    if (reqs.length) await withRetry(() => d.sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: reqs } }));
    await withRetry(() => d.sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: Object.keys(cells).map(ci => ({ range: `${tab}!${idxToColLetter(+ci)}${newRow}`, values: [[cells[ci]]] }))
    } }));
    clearSheetCache(spreadsheetId);
    res.json({ success: true, row: newRow });
  } catch (err) { fmsManualErr(res, err); }
});

// ══════════════════════════════════════════════════════
// FMS FILE UPLOADS — extra-input ke image / PDF / video
// ══════════════════════════════════════════════════════
// File DB me base64 store hoti hai; sheet me sirf uska open-link jaata hai.
const FMS_UPLOAD_TYPES = {
  image: { label: 'Image', accept: 'image/*', mimes: ['image/'] },
  pdf:   { label: 'PDF',   accept: 'application/pdf', mimes: ['application/pdf'] },
  video: { label: 'Video', accept: 'video/*', mimes: ['video/'] }
};
const FMS_UPLOAD_MAX_BYTES = 15 * 1024 * 1024;   // 15 MB

// POST /api/fms-uploads — base64 file save karo, link wapas do
app.post('/api/fms-uploads', requireAuth, async (req, res) => {
  try {
    const { fmsId, stepId, rowIndex, colLetter, fieldType, fileName, mimeType, dataUrl } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'File missing' });

    const spec = FMS_UPLOAD_TYPES[fieldType];
    if (!spec) return res.status(400).json({ error: 'Field type galat hai' });
    const mime = String(mimeType || '');
    if (!spec.mimes.some(p => mime.startsWith(p)))
      return res.status(400).json({ error: `Sirf ${spec.label} file allowed hai` });

    // base64 payload size (data:...;base64,XXXX) — 4 base64 chars = 3 bytes
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const bytes = Math.floor(b64.length * 3 / 4);
    if (bytes > FMS_UPLOAD_MAX_BYTES)
      return res.status(400).json({ error: `File bahut badi hai (max ${FMS_UPLOAD_MAX_BYTES / 1024 / 1024} MB)` });

    const d = await getDB();
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    const saved = await d.insert('FMS_Uploads', {
      fms_id: String(fmsId || ''), step_id: String(stepId || ''),
      row_index: String(rowIndex || ''), col_letter: String(colLetter || ''),
      file_name: String(fileName || 'file'), mime_type: mime,
      file_size: String(bytes), file_data: dataUrl,
      uploaded_by: String(req.session.userId), created_at: nowStr
    });

    const base = (process.env.APP_URL || '').replace(/\/+$/, '');
    res.json({
      success: true, id: parseInt(saved.id),
      url: `${base}/f/${saved.id}`,          // sheet me yahi link jaata hai
      fileName: String(fileName || 'file'), size: bytes
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /f/:id — uploaded file kholo (sheet ke link se click karne par)
app.get('/f/:id', async (req, res) => {
  try {
    const d = await getDB();
    const row = await d.findOne('FMS_Uploads', { id: String(req.params.id) });
    if (!row) return res.status(404).send('File not found');
    const dataUrl = String(row.file_data || '');
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (!b64) return res.status(404).send('File empty');
    const buf = Buffer.from(b64, 'base64');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${String(row.file_name || 'file').replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ══════════════════════════════════════════════════════
// FMS ENTRY FORM — naye rows sheet me daalne ke liye (Delhi Sales jaisa form)
// ══════════════════════════════════════════════════════
// Entry form ke input columns — sheet ke header order ke hisaab se (A..H).
// Timestamp app khud bharta hai, UNIQ ID auto-generate hota hai.
const FMS_ENTRY_FIELDS = [
  { col: 'A', key: 'timestamp',    label: 'Timestamp',            type: 'auto' },
  { col: 'B', key: 'uniqId',       label: 'UNIQ ID',              type: 'auto' },
  { col: 'C', key: 'name',         label: 'Name',                 type: 'text',   required: true },
  { col: 'D', key: 'phone',        label: 'Phone Number',         type: 'tel',    required: true },
  { col: 'E', key: 'salesPerson',  label: 'Sales Person Attended',type: 'text',   required: true },
  { col: 'F', key: 'dateOfSale',   label: 'Date of Sale',         type: 'date',   required: true },
  { col: 'G', key: 'billNo',       label: 'Bill No.',             type: 'text',   required: true },
  { col: 'H', key: 'saleType',     label: 'Sale Type',            type: 'select', required: true,
    options: ['Store Visit', 'Customised'] }
];

// Formula injection rok — "=" / "+" / "-" / "@" se shuru hone wali text value
// USER_ENTERED mode me sheet ke andar formula ban jaati hai, isliye escape karo
function sheetSafeText(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

// dd/MM/yyyy HH:mm:ss — sheet ke Timestamp format jaisa (IST)
function fmsEntryTimestamp() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

// Sheet ke existing UNIQ IDs dekh kar agla number — prefix + zero-padded
function nextUniqId(existingIds, prefix, pad) {
  let max = 0;
  for (const raw of existingIds) {
    const m = String(raw || '').trim().match(new RegExp('^' + prefix + '-?(\\d+)$', 'i'));
    if (m) { const n = parseInt(m[1]); if (n > max) max = n; }
  }
  return `${prefix}-${String(max + 1).padStart(pad, '0')}`;
}

// Entry form ka target tab — naya data FORM tab me jaata hai (FMS tab wahi
// data formulas ke through kheenchta hai). FORM naam ka tab na mile to FMS
// config wala tab hi use hota hai.
async function fmsEntryTarget(d, spreadsheetId, fallbackTab) {
  const meta = await withRetry(() => d.sheets.spreadsheets.get({
    spreadsheetId, fields: 'sheets(properties(title,sheetId,gridProperties(rowCount,columnCount)))'
  }));
  const sheets = meta.data.sheets || [];
  const target = sheets.find(s => String(s.properties.title || '').trim().toUpperCase() === 'FORM')
              || sheets.find(s => s.properties.title === fallbackTab);
  if (!target) return null;
  const g = target.properties.gridProperties || {};
  return {
    tabName: target.properties.title,
    sheetId: target.properties.sheetId,
    rowCount: g.rowCount || 0,
    columnCount: g.columnCount || 0
  };
}

// Header row dhoondo — wo row jisme "UNIQ ID" likha hai (FORM tab me row 1,
// FMS tab me row 6). Na mile to 1 maan lo.
function fmsEntryHeaderRow(all) {
  for (let i = 0; i < Math.min(12, all.length); i++) {
    const row = (all[i] || []).map(v => String(v || '').trim().toUpperCase());
    if (row.includes('UNIQ ID') || row.includes('UNIQID')) return i + 1;
  }
  return 1;
}

// GET /api/fms-entry/:fmsId/config — form fields + agli UNIQ ID
app.get('/api/fms-entry/:fmsId/config', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
    if (!fmsRow) return res.status(404).json({ error: 'FMS not found' });
    const fms = parseFMSRow(fmsRow);
    const spreadsheetId = extractSheetId(fms.sheet_id);

    const target = await fmsEntryTarget(d, spreadsheetId, fms.sheet_name);
    if (!target) return res.status(404).json({ error: 'Entry tab (FORM) nahi mila' });

    const resp = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId, range: `${target.tabName}!A1:H`
    }));
    const all = resp.data.values || [];
    const headerRow = fmsEntryHeaderRow(all);
    const headers = all[headerRow - 1] || [];
    const idCol = colLetterToIdx('B');
    const existingIds = all.slice(headerRow).map(r => (r || [])[idCol]).filter(Boolean);

    res.json({
      fmsName: fms.fms_name || fms.sheet_name,
      fields: FMS_ENTRY_FIELDS,
      headers,
      tabName: target.tabName,
      nextUniqId: nextUniqId(existingIds, 'DS', 4)
    });
  } catch (err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — FMS sheet ko service account ke saath share karo';
    if (msg.includes('404')) msg = 'Sheet not found — FMS config mein Sheet ID/Tab check karo';
    res.status(500).json({ error: msg });
  }
});

// POST /api/fms-entry/:fmsId/submit — ek ya multiple rows sheet me append
app.post('/api/fms-entry/:fmsId/submit', requireAuth, async (req, res) => {
  try {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'Kam se kam ek row chahiye' });

    const validOptions = FMS_ENTRY_FIELDS.find(f => f.key === 'saleType').options;
    for (const [i, row] of rows.entries()) {
      for (const f of FMS_ENTRY_FIELDS) {
        if (f.required && !String(row[f.key] || '').trim())
          return res.status(400).json({ error: `Row ${i + 1}: ${f.label} required hai` });
      }
      if (!validOptions.includes(String(row.saleType).trim()))
        return res.status(400).json({ error: `Row ${i + 1}: Sale Type galat hai` });
    }

    const d = await getDB();
    const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
    if (!fmsRow) return res.status(404).json({ error: 'FMS not found' });
    const fms = parseFMSRow(fmsRow);
    const spreadsheetId = extractSheetId(fms.sheet_id);

    // Data FORM tab me jaata hai (FMS tab wahi se kheenchta hai)
    const meta = await fmsEntryTarget(d, spreadsheetId, fms.sheet_name);
    if (!meta) return res.status(404).json({ error: 'Entry tab (FORM) nahi mila' });

    // Poora tab padho — agli khali row aur formula-template row dhoondhne ke liye
    const resp = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId, range: `${meta.tabName}!A1:ZZ`
    }));
    const all = resp.data.values || [];
    const headerRow = fmsEntryHeaderRow(all);
    const dataRows = all.slice(headerRow);

    // Aakhri ASLI bhari hui data row — uske neeche append karenge.
    // FALSE/TRUE ko data nahi maante: sheet me neeche tak drag kiye hue
    // checkbox/formula cells hote hain jo poori grid ke end tak "FALSE" dete
    // hain — unhe data maan lein to append point sheet ki limit ke bahar chala
    // jaata hai. Yahi rule baaki FMS code (hasRealData) me bhi hai.
    let lastFilledIdx = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i] || [];
      const real = r.slice(0, 8).some(v => {
        const s = String(v || '').trim().toUpperCase();
        return s !== '' && s !== 'FALSE' && s !== 'TRUE';
      });
      if (real) lastFilledIdx = i;
    }
    const firstNewRow = headerRow + lastFilledIdx + 2; // 1-based sheet row

    const idCol = colLetterToIdx('B');
    const existingIds = dataRows.map(r => (r || [])[idCol]).filter(Boolean);
    const ts = fmsEntryTimestamp();

    const values = rows.map(row => {
      const uniq = nextUniqId(existingIds, 'DS', 4);
      existingIds.push(uniq);
      return [
        ts, uniq,
        sheetSafeText(row.name), sheetSafeText(row.phone), sheetSafeText(row.salesPerson),
        String(row.dateOfSale || '').trim(),   // ISO date — Sheets khud parse karta hai
        sheetSafeText(row.billNo),
        String(row.saleType).trim()            // whitelist se already validate ho chuka
      ];
    });

    // Tab ki grid me itni rows hain ya nahi — na hon to pehle expand karo,
    // warna "Range exceeds grid limits" error aata hai
    const lastNeededRow = firstNewRow + values.length - 1;
    if (meta.rowCount && lastNeededRow > meta.rowCount) {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ appendDimension: {
          sheetId: meta.sheetId, dimension: 'ROWS',
          length: (lastNeededRow - meta.rowCount) + 100   // thoda buffer
        }}]}
      }));
    }

    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${meta.tabName}!A${firstNewRow}:H${lastNeededRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    }));

    // Agar is tab me H ke aage formula columns hain (FMS-style layout) to unhe
    // naye rows me copy karo — warna row kisi step me pending nahi dikhegi.
    // FORM tab me H ke aage kuch nahi hota, to ye apne aap skip ho jaata hai.
    if (lastFilledIdx >= 0) {
      const templateRow = headerRow + lastFilledIdx + 1;
      // Header ke columns tak, par sheet ki grid width se aage nahi
      const headerCols = (all[headerRow - 1] || []).length;
      const endCol = Math.min(headerCols, meta.columnCount || headerCols);
      if (endCol > 8) {
        await withRetry(() => d.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests: [{ copyPaste: {
            source: { sheetId: meta.sheetId, startRowIndex: templateRow - 1, endRowIndex: templateRow,
                      startColumnIndex: 8, endColumnIndex: endCol },
            destination: { sheetId: meta.sheetId, startRowIndex: firstNewRow - 1,
                           endRowIndex: firstNewRow - 1 + values.length,
                           startColumnIndex: 8, endColumnIndex: endCol },
            pasteType: 'PASTE_FORMULA'
          }}]}
        }));
      }
    }

    res.json({ success: true, count: values.length, uniqIds: values.map(v => v[1]), firstRow: firstNewRow });
  } catch (err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — sheet ko service account ke saath Editor access do';
    res.status(500).json({ error: msg });
  }
});

// ══════════════════════════════════════════════════════
// TASK TRANSFERS
// ══════════════════════════════════════════════════════
app.post('/api/transfers', requireAuth, async (req, res) => {
  try {
    const { tasks, toUserId } = req.body;
    if (!tasks || !tasks.length || !toUserId)
      return res.status(400).json({ error: 'Tasks and target user required' });
    const uid = req.session.userId;
    const role = req.session.role;

    for (const t of tasks) {
      const tabName = getTabName(t.taskType);
      const task = await db.findOne(tabName, { id: String(t.taskId) });
      if (!task) return res.status(404).json({ error: `Task ${t.taskId} not found` });
      if (role === 'user' && String(task.assigned_to) !== String(uid))
        return res.status(403).json({ error: 'You can only transfer your own tasks' });
      if (role === 'hod') {
        const taskUser = await db.findOne('Users', { id: String(task.assigned_to) });
        const hodUser = await db.findOne('Users', { id: String(uid) });
        if (taskUser?.department !== hodUser?.department)
          return res.status(403).json({ error: 'HOD can only transfer tasks of their department' });
      }
    }

    let inserted = 0, skipped = 0;
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    for (const t of tasks) {
      const tabName = getTabName(t.taskType);
      const task = await db.findOne(tabName, { id: String(t.taskId) });
      const fromUser = task.assigned_to;
      const existingPending = (await db.findWhere('Task_Transfers', { task_id: String(t.taskId), task_type: t.taskType, status: 'pending' }));
      if (existingPending.length) { skipped++; continue; }
      await db.insert('Task_Transfers', {
        task_id: String(t.taskId), task_type: t.taskType,
        from_user: String(fromUser), to_user: String(toUserId),
        requested_by: String(uid), status: 'pending', note: '', created_at: nowStr
      });
      inserted++;
    }
    res.json({ success: true, count: inserted, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transfers/pending-tasks', requireAuth, async (req, res) => {
  try {
    const transfers = await db.findWhere('Task_Transfers', { status: 'pending', requested_by: String(req.session.userId) });
    res.json(transfers.map(t => ({ task_id: parseInt(t.task_id), task_type: t.task_type })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transfers', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;

    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    let transfers = await db.findAll('Task_Transfers');
    transfers = transfers.filter(t => t.status === 'pending');

    if (role === 'hod') {
      const meUser = await db.findOne('Users', { id: String(uid) });
      const dept = meUser?.department || '';
      const deptUserIds = allUsers.filter(u => u.department === dept).map(u => String(u.id));
      if (!deptUserIds.length) return res.json([]);
      transfers = transfers.filter(t => deptUserIds.includes(String(t.from_user)) || deptUserIds.includes(String(t.to_user)));
    }

    const result = [];
    for (const tr of transfers) {
      let description = '—', due_date = '—';
      const tabName = getTabName(tr.task_type);
      const task = await db.findOne(tabName, { id: tr.task_id });
      if (task) { description = task.description; due_date = task.due_date || '—'; }
      const fromUser = userMap[String(tr.from_user)];
      result.push({
        ...tr,
        id: parseInt(tr.id),
        task_id: parseInt(tr.task_id),
        from_user: parseInt(tr.from_user),
        to_user: parseInt(tr.to_user),
        requested_by: parseInt(tr.requested_by),
        fromUserName: userMap[String(tr.from_user)]?.name || '',
        toUserName: userMap[String(tr.to_user)]?.name || '',
        requestedByName: userMap[String(tr.requested_by)]?.name || '',
        fromDept: fromUser?.department || '',
        description, due_date
      });
    }
    result.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transfers/count', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const uid = req.session.userId;
    const role = req.session.role;
    let transfers = await db.findAll('Task_Transfers');
    transfers = transfers.filter(t => t.status === 'pending');
    if (role !== 'admin') {
      const meUser = await db.findOne('Users', { id: String(uid) });
      const dept = meUser?.department || '';
      const allUsers = await db.findAll('Users');
      const deptUserIds = allUsers.filter(u => u.department === dept).map(u => String(u.id));
      transfers = transfers.filter(t => deptUserIds.includes(String(t.from_user)) || deptUserIds.includes(String(t.to_user)));
    }
    res.json({ count: transfers.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/transfers/:id', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { action, note } = req.body;
    const tr = await db.findOne('Task_Transfers', { id: req.params.id });
    if (!tr) return res.status(404).json({ error: 'Transfer not found' });
    await db.update('Task_Transfers', req.params.id, { status: action, note: note || '' });
    if (action === 'approved') {
      const tabName = getTabName(tr.task_type);
      const trUpd = { assigned_to: String(tr.to_user) };
      // Checklist me doer ka naam bhi saath badal do, warna DB me purana naam
      // reh jaata (ye column sirf padhne ke liye hai)
      if (tabName === 'Checklist_Tasks') trUpd.doer_name = await doerNameFor(tr.to_user);
      await db.update(tabName, tr.task_id, trUpd);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/transfers/my', requireAuth, async (req, res) => {
  try {
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;
    let transfers = await db.findWhere('Task_Transfers', { requested_by: String(req.session.userId) });
    transfers.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    transfers = transfers.slice(0, 20);
    const result = [];
    for (const tr of transfers) {
      let description = '—';
      const tabName = getTabName(tr.task_type);
      const task = await db.findOne(tabName, { id: tr.task_id });
      if (task) description = task.description;
      result.push({
        ...tr,
        id: parseInt(tr.id),
        fromUserName: userMap[String(tr.from_user)]?.name || '',
        toUserName: userMap[String(tr.to_user)]?.name || '',
        description
      });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// WEEK PLAN
// ══════════════════════════════════════════════════════
app.post('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, startDate, targetCount, hodId, improvementPct } = req.body;
    if (!employeeId || !startDate) return res.json({ error: 'employeeId and startDate required' });
    const impPct = (improvementPct !== undefined && improvementPct !== null && improvementPct !== '') ? String(parseInt(improvementPct)) : '';
    const tCount = (targetCount !== undefined && targetCount !== null && targetCount !== '') ? String(parseInt(targetCount)) : '0';
    const finalHodId = String(hodId || req.session.userId);
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Check for existing plan (upsert)
    const existing = await db.findWhere('Week_Plans', { employee_id: String(employeeId), start_date: startDate });
    if (existing.length) {
      await db.update('Week_Plans', existing[0].id, {
        target_count: tCount, hod_id: finalHodId, improvement_pct: impPct, updated_at: nowStr
      });
      console.log(`  Week Plan UPDATED: employee=${employeeId}, week=${startDate}`);
    } else {
      await db.insert('Week_Plans', {
        employee_id: String(employeeId), hod_id: finalHodId, start_date: startDate,
        target_count: tCount, improvement_pct: impPct, created_at: nowStr, updated_at: nowStr
      });
      console.log(`  Week Plan INSERTED: employee=${employeeId}, week=${startDate}`);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('  Week Plan save failed:', e);
    res.json({ error: 'Failed to save plan' });
  }
});

app.get('/api/week-plan', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { employeeId, from, to } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    let hodDept = '';
    if (req.session.role === 'hod') {
      const meUser = await db.findOne('Users', { id: String(req.session.userId) });
      hodDept = meUser?.department || '';
    }

    let plans = await db.findAll('Week_Plans');
    if (employeeId) plans = plans.filter(p => String(p.employee_id) === String(employeeId));
    if (from) plans = plans.filter(p => p.start_date >= from);
    if (to) plans = plans.filter(p => p.start_date <= to);
    if (req.session.role === 'hod') {
      plans = plans.filter(p => {
        const u = userMap[String(p.employee_id)];
        return u && u.department === hodDept;
      });
    }
    plans.sort((a, b) => (b.start_date || '').localeCompare(a.start_date || '') || (a.employee_id || '').localeCompare(b.employee_id || ''));
    plans = plans.slice(0, limit);

    const result = plans.map(p => ({
      id: parseInt(p.id),
      employee_id: parseInt(p.employee_id),
      hod_id: parseInt(p.hod_id),
      start_date: p.start_date,
      target_count: parseInt(p.target_count) || 0,
      improvement_pct: p.improvement_pct !== '' ? parseInt(p.improvement_pct) : null,
      created_at: p.created_at, updated_at: p.updated_at,
      employee_name: userMap[String(p.employee_id)]?.name || '',
      employee_department: userMap[String(p.employee_id)]?.department || '',
      hod_name: userMap[String(p.hod_id)]?.name || ''
    }));
    res.json(result);
  } catch (e) {
    console.error('  Week Plan fetch failed:', e.message);
    res.json([]);
  }
});

app.get('/api/week-plan/history/:employeeId', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const empId = parseInt(req.params.employeeId);
    if (!empId) return res.json({ error: 'Invalid employeeId' });
    const allUsers = await db.findAll('Users');
    const userMap = {};
    for (const u of allUsers) userMap[String(u.id)] = u;

    if (req.session.role === 'hod') {
      const meUser = await db.findOne('Users', { id: String(req.session.userId) });
      const myDept = meUser?.department || '';
      const empUser = userMap[String(empId)];
      if (!empUser || empUser.department !== myDept) return res.status(403).json({ error: 'Not allowed' });
    }

    let plans = await db.findWhere('Week_Plans', { employee_id: String(empId) });
    plans.sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
    const emp = userMap[String(empId)];
    res.json({
      employee: emp ? { id: parseInt(emp.id), name: emp.name, department: emp.department } : null,
      plans: plans.map(p => ({
        id: parseInt(p.id),
        start_date: p.start_date,
        target_count: parseInt(p.target_count) || 0,
        improvement_pct: p.improvement_pct !== '' ? parseInt(p.improvement_pct) : null,
        created_at: p.created_at, updated_at: p.updated_at,
        hod_name: userMap[String(p.hod_id)]?.name || ''
      })),
      total: plans.length
    });
  } catch (e) {
    console.error('  Week Plan history fetch failed:', e.message);
    res.json({ error: 'Failed to fetch history', plans: [] });
  }
});

// ══════════════════════════════════════════════════════
// ADMIN ROUTES
// ══════════════════════════════════════════════════════
app.post('/api/admin/run-reminders', requireAuth, requireAdmin, async (req, res) => {
  const r = await runDelegationReminders();
  res.json(r);
});

// Cron/keep-alive endpoint — Hostinger cron job ise har 10 min hit karta hai.
// Shared hosting par app idle hone par so jaata hai aur setInterval scheduler
// nahi chalta; ye request app ko jagati hai. Agar abhi koi reminder slot ki
// 30-min window chal rahi hai aur us slot ka reminder aaj nahi gaya, to bhejta
// hai (scheduler ke saath shared _waFiredSlots se dedup — double kabhi nahi).
// Wahi catch-up logic jo scheduler aur request-hook use karte hain, taaki
// teeno raste ek jaise chalein. Status bhi wapas bhejta hai (diagnose ke liye).
// "2 ghante 13 min" jaisa — app kab se chal rahi hai
function uptimeText() {
  const ms = Date.now() - _bootAt;
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  return (h ? h + ' ghante ' : '') + (min % 60) + ' min se chal rahi hai' +
         ' (boot: ' + new Date(_bootAt + 330 * 60000).toISOString().replace('T', ' ').slice(0, 16) + ' IST)';
}

// App_State me rakhi kisi ek value ko padho (marker chala ya nahi)
async function appStateValue(key) {
  try {
    const d = await getDB();
    const rows = await d.findWhere('App_State', { key_name: key });
    return (rows && rows.length) ? (rows[0].value || 'done') : 'abhi nahi chala';
  } catch { return null; }
}

// Jinki date ajeeb hai unka namuna — kis doer ki, kaunsi id, kya likha hai.
// (7 Sep: screen par "—" dikh raha tha; bina namune dekhe do baar galat
// natija nikala. Ab pehle dekh lete hain.)
async function checklistOddSample(limit) {
  try {
    const d = await getDB();
    const all = await d.findAll('Checklist_Tasks');
    const odd = all.filter(t => {
      const v = String(t.due_date == null ? '' : t.due_date).trim();
      return v && !/^\d{4}-\d{2}-\d{2}$/.test(v);
    });
    const byDoer = {};
    odd.forEach(t => {
      const n = t.doer_name || ('id ' + t.assigned_to);
      byDoer[n] = (byDoer[n] || 0) + 1;
    });
    return {
      kitni: odd.length,
      kis_kis_ki: byDoer,
      namune: odd.slice(0, limit || 6).map(t => ({
        id: t.id, due_date: t.due_date, frequency: t.frequency,
        status: t.status, doer: t.doer_name || ''
      }))
    };
  } catch (e) { return { error: e.message }; }
}

// ── BINA DOER WALE PENDING TASK HATA DO (ek baar) ──────────────
// Harsh (10 Sep 2026): "Shivam user delete kiya hai, task bhi uske."
// Jis bande ka account hi nahi raha, uske khule task rakhne ka matlab nahi.
//
// SAAVDHANI: ye rows sach me DELETE hoti hain. Isliye hatane se PEHLE unki
// poori nakal App_State me rakh dete hain (key: checklist_orphan_backup_v1),
// taaki zarurat pade to wapas daali ja sakein.
// Sirf wahi rows jinka assigned_to Users me hai hi nahi, AUR status
// pending/revised ho. Completed/closed ko haath nahi lagate — wo hisaab-kitab
// (MIS) ka record hai.
async function removeOrphanOpenTasks() {
  const MARKER = 'orphan_open_tasks_removed_v1';
  const BACKUP = 'checklist_orphan_backup_v1';
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const done = await d.findWhere('App_State', { key_name: MARKER });
    if (done && done.length) return;

    const [chl, del, users] = await Promise.all([
      d.findAll('Checklist_Tasks'), d.findAll('Delegation_Tasks'), d.findAll('Users')
    ]);
    const known = new Set(users.map(u => String(u.id)));
    const isOpen = t => t.status === 'pending' || t.status === 'revised';
    const orphan = t => !known.has(String(t.assigned_to || ''));

    const chlRows = chl.filter(t => isOpen(t) && orphan(t));
    const delRows = del.filter(t => isOpen(t) && orphan(t));
    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];

    if (!chlRows.length && !delRows.length) {
      await d.insert('App_State', { key_name: MARKER, value: 'koi bina-doer wala khula task nahi mila', updated_at: nowStr });
      console.log('  orphan tasks: koi nahi mila');
      return;
    }

    // Pehle nakal, phir hatana
    try {
      await d.insert('App_State', {
        key_name: BACKUP,
        value: JSON.stringify({ at: nowStr, checklist: chlRows, delegation: delRows }),
        updated_at: nowStr
      });
    } catch (e) {
      console.error('  orphan tasks: nakal nahi bani, isliye kuch NAHI hataya:', e.message);
      return;   // nakal na bane to delete bhi mat karo
    }

    let gaye = 0, atke = 0;
    for (const t of chlRows) {
      try { await d.delete('Checklist_Tasks', t.id); gaye++; } catch { atke++; }
    }
    for (const t of delRows) {
      try { await d.delete('Delegation_Tasks', t.id); gaye++; } catch { atke++; }
    }

    const msg = `${gaye} bina-doer wale khule task hataye` + (atke ? `, ${atke} nahi hate` : '') +
                ` (nakal ${BACKUP} me rakhi hai)`;
    await d.insert('App_State', { key_name: MARKER, value: msg, updated_at: nowStr });
    console.log('  \u2705 orphan tasks: ' + msg);
  } catch (e) {
    console.error('  removeOrphanOpenTasks error (agli baar retry hogi):', e.message);
  }
}

// DB me column sach me bane ya nahi — phpMyAdmin kholne ki zarurat na pade.
// Harsh (12 Sep): "db me bhi kar diya hai na ki kisne done kiya, main pakad
// saku?" -- iska jawab dikha kar dena chahiye, keh kar nahi.
async function tableCols() {
  try {
    const d = await getDB();
    const out = {};
    for (const t of ['Delegation_Tasks', 'Checklist_Tasks']) {
      if (d.pool) {
        const [rows] = await d.pool.query(
          'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS ' +
          'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [t]);
        out[t] = rows.map(r => r.COLUMN_NAME);
      } else {
        const all = await d.findAll(t);
        out[t] = all.length ? Object.keys(all[0]) : [];
      }
    }
    const chahiye = ['status_changed_at', 'status_changed_by', 'status_changed_by_name'];
    out.NAYE_COLUMN_BANE = chahiye.every(c => (out['Delegation_Tasks'] || []).includes(c))
      ? 'HAAN — teeno ban gaye' : 'NAHI — abhi nahi bane';
    return out;
  } catch (e) { return { error: e.message }; }
}

// Delegation task ka haal — kitne kis status me, aur jo completed hain unme
// se kitno ka record hai ki kisne kiya. Harsh (12 Sep 2026): "task auto done
// kyun hua, bina kisi ke kiye?" -- jawab ginti se dena hai, andaze se nahi.
async function delegationAudit() {
  try {
    const d = await getDB();
    const [del, appr, users] = await Promise.all([
      d.findAll('Delegation_Tasks'), d.findAll('Task_Approvals'), d.findAll('Users')
    ]);
    const nameOf = {};
    users.forEach(u => { nameOf[String(u.id)] = u.name; });

    const ginti = {};
    del.forEach(t => { const st = t.status || '(khali)'; ginti[st] = (ginti[st] || 0) + 1; });

    const done = del.filter(t => t.status === 'completed' || t.status === 'closed');
    const recordHai = done.filter(t => t.status_changed_at);
    // Kaunse completed task approval se hue (uska record Task_Approvals me hai)
    const apprDone = new Set(appr.filter(a => a.status === 'approved').map(a => String(a.task_id)));

    // Sabse naye approval — kisne, kab
    const lastAppr = appr.slice().sort((a, b) =>
      String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 8);

    return {
      kul_delegation: del.length,
      status_ki_ginti: ginti,
      completed_ya_closed: done.length,
      inme_se_jinka_record_hai: recordHai.length,
      inme_se_jo_approval_se_hue: done.filter(t => apprDone.has(String(t.id))).length,
      naye_record: recordHai.slice(-8).map(t => ({
        id: t.id, kab: t.status_changed_at,
        kisne: t.status_changed_by_name || nameOf[String(t.status_changed_by)] || t.status_changed_by,
        status: t.status, kaam: String(t.description || '').slice(0, 45)
      })),
      aakhri_approvals: lastAppr.map(a => ({
        task_id: a.task_id, kism: a.action_type, status: a.status,
        maanga: nameOf[String(a.requested_by)] || a.requested_by,
        kisse: nameOf[String(a.requested_to)] || a.requested_to,
        kab: a.created_at
      }))
    };
  } catch (e) { return { error: e.message }; }
}

// Aaj reminder KIS-KIS ko jayega, aur kaun chhoot raha hai aur kyun.
// Harsh (11 Sep): "har number par proper message ja raha hai na, koi skip to
// nahi hota?" -- ginti se jawab dene ke liye. Wahi shartein jo asli pass
// lagata hai: pending task + due_date aaj se 2 din ke andar.
async function reminderWho() {
  try {
    const d = await getDB();
    const [del, chl, users] = await Promise.all([
      d.findAll('Delegation_Tasks'), d.findAll('Checklist_Tasks'), d.findAll('Users')
    ]);
    const cutoff = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const isPending = t => t.status === 'pending' && t.due_date && dueIso(t.due_date) <= cutoff;
    const byUser = {};
    [...del, ...chl].forEach(t => {
      if (!isPending(t)) return;
      const uid = String(t.assigned_to);
      byUser[uid] = (byUser[uid] || 0) + 1;
    });
    const userMap = {};
    users.forEach(u => { userMap[String(u.id)] = u; });
    const excluded = new Set((WA.reminderExcludePhones || []).map(normalizePhone).filter(Boolean));

    const milega = [], binaPhone = [], chhoda = [], userHiNahi = [];
    Object.keys(byUser).forEach(uid => {
      const u = userMap[uid];
      if (!u) { userHiNahi.push({ assigned_to: uid, tasks: byUser[uid] }); return; }
      const ph = u.phone ? normalizePhone(u.phone) : '';
      if (!ph) { binaPhone.push({ name: u.name, tasks: byUser[uid] }); return; }
      if (excluded.has(ph)) { chhoda.push({ name: u.name, phone: ph }); return; }
      milega.push({ name: u.name, phone: ph, tasks: byUser[uid] });
    });

    return {
      kul_users: users.length,
      jinke_pending_task_hain: Object.keys(byUser).length,
      MESSAGE_MILEGA: milega.length,
      bina_phone_ke_chhoot_gaye: binaPhone.length,
      bina_phone_naam: binaPhone.map(x => x.name + ' (' + x.tasks + ' task)'),
      jaan_bujh_kar_chhoda: chhoda,
      user_hi_nahi_mila: userHiNahi,
      milne_wale: milega.map(x => x.name + ' — ' + x.phone + ' (' + x.tasks + ' task)')
    };
  } catch (e) { return { error: e.message }; }
}

// Jin task ka doer resolve nahi hota (Users me wo id hai hi nahi, ya
// assigned_to khali hai) -- All Tasks/PC me unka group "-" ban jaata hai.
// 10 Sep 2026: Harsh ne aisa hi ek group dekha, isliye ye jhaank.
async function orphanDoers() {
  try {
    const d = await getDB();
    const [chl, del, users] = await Promise.all([
      d.findAll('Checklist_Tasks'), d.findAll('Delegation_Tasks'), d.findAll('Users')
    ]);
    const known = new Set(users.map(u => String(u.id)));
    const pick = (rows, kind) => rows
      .filter(t => (t.status === 'pending' || t.status === 'revised'))
      .filter(t => !known.has(String(t.assigned_to || '')))
      .map(t => ({
        kind, id: t.id, assigned_to: t.assigned_to, doer_name: t.doer_name || '',
        assigned_by: t.assigned_by, due_date: t.due_date, status: t.status,
        desc: String(t.description || '').slice(0, 40)
      }));
    const all = pick(chl, 'checklist').concat(pick(del, 'delegation'));
    return { kitne: all.length, users_me_kitni_ids: known.size, namune: all.slice(0, 10) };
  } catch (e) { return { error: e.message }; }
}

// ── "Likha Kavita hai, dikh Anand ko raha hai" wale task dhoondo ──
// Checklist row me DO jagah doer ka zikr hota hai:
//   assigned_to  -> ID. App SIRF isse tay karti hai ki task kisko dikhega.
//   doer_name    -> naam. Sirf phpMyAdmin me padhne ke liye.
// Dono alag ho jayein to DB me naam kuch aur dikhta hai aur task kisi aur ko
// milta hai -- Harsh ne 15 Sep 2026 ko yahi pakda. Ye function wahi rows
// ginta hai. Sirf padhta hai, kuch badalta nahi.
async function doerMismatch() {
  try {
    const d = await getDB();
    const [chl, users] = await Promise.all([
      d.findAll('Checklist_Tasks'), d.findAll('Users')
    ]);
    const byId = {};
    users.forEach(u => { byId[String(u.id)] = String(u.name || ''); });
    const norm = s => String(s || '').trim().toLowerCase();
    const byName = {};
    users.forEach(u => { (byName[norm(u.name)] = byName[norm(u.name)] || []).push(u); });

    const bad = [];
    for (const t of chl) {
      const likha = String(t.doer_name || '').trim();
      if (!likha) continue;                       // khali hai to compare kya karein
      const dikhta = byId[String(t.assigned_to)];
      if (dikhta === undefined) continue;         // orphan -- uske liye ?orphans=1 hai
      if (norm(likha) === norm(dikhta)) continue; // dono ek hi -- theek hai
      bad.push({
        id: t.id,
        DB_me_likha_hai: likha,
        TASK_ISKO_DIKH_RAHA_HAI: dikhta,
        status: t.status,
        due_date: t.due_date
      });
    }
    // Kis jodi me kitni baar -- "Kavita -> Anand: 37" jaisa
    const jodi = {};
    bad.forEach(b => {
      const k = `${b.DB_me_likha_hai} -> ${b.TASK_ISKO_DIKH_RAHA_HAI}`;
      jodi[k] = (jodi[k] || 0) + 1;
    });

    // ── Har jodi ka faisla: NAAM BADLA hai ya SACH ME GALAT AADMI? ──
    // Ye farak sabse zaroori hai, aur ginti se hi pata chalta hai:
    //   likha hua naam Users me hai HI NAHI  -> us bande ka naam badal diya
    //       gaya tha. Task sahi aadmi ke paas hi hai, bas doer_name purana
    //       pada hai. Task HILANA NAHI hai -- sirf label purana hai.
    //   likha hua naam ek ALAG user ka hai   -> task sach me galat aadmi ke
    //       paas hai. Yahi wo cheez hai jo theek honi chahiye.
    const faisla = Object.keys(jodi).map(k => {
      const likha = k.split(' -> ')[0];
      const match = byName[norm(likha)] || [];
      let kya;
      if (match.length === 0) kya = 'NAAM BADLA LAGTA HAI -- "' + likha + '" naam ka koi user hai hi nahi. Task sahi aadmi ke paas hai, sirf purana label pada hai. HILANA NAHI.';
      else if (match.length > 1) kya = 'ISI NAAM KE ' + match.length + ' USER HAIN -- khud se nahi chun sakte, haath nahi lagayenge.';
      else kya = 'ASLI GADBAD -- "' + likha + '" (id ' + match[0].id + ') ek alag user hai. Task galat aadmi ke paas hai.';
      return { jodi: k, kitne: jodi[k], faisla: kya };
    }).sort((a, b) => b.kitne - a.kitne);

    // ── RENAME hai ya SACH ME GALAT AADMI -- pakka faisla ──
    // Tarika: jis id par mismatch hai, USI id ke saare task ke label dekho.
    // Agar ek hi id par do naam mile aur purana naam sirf PURANE task par ho
    // (nayi tareekh wale task par naya naam), to us account ka naam badla
    // tha -- task wahin ke wahin hain, sahi bande ke paas. Agar purana naam
    // nayi tareekh par bhi chal raha hai, to baat rename ki nahi hai.
    const idsMe = [...new Set(chl.filter(t => {
      const l = String(t.doer_name || '').trim();
      if (!l) return false;
      const dk = byId[String(t.assigned_to)];
      return dk !== undefined && norm(l) !== norm(dk);
    }).map(t => String(t.assigned_to)))];

    const jaanch = idsMe.map(id => {
      const rows = chl.filter(t => String(t.assigned_to) === id);
      const label = {};
      rows.forEach(t => {
        const l = String(t.doer_name || '').trim() || '(khali)';
        if (!label[l]) label[l] = { kitne: 0, pehla: '', aakhri: '' };
        const e = label[l];
        e.kitne++;
        const c = String(t.created_at || '');
        if (c) {
          if (!e.pehla || c < e.pehla) e.pehla = c;
          if (!e.aakhri || c > e.aakhri) e.aakhri = c;
        }
      });
      return {
        user: `${byId[id]} (id ${id})`,
        is_id_par_kaunse_naam: Object.entries(label)
          .sort((a, b) => b[1].kitne - a[1].kitne)
          .map(([l, e]) => `"${l}" -- ${e.kitne} task (${e.pehla ? e.pehla.slice(0, 10) : '?'} se ${e.aakhri ? e.aakhri.slice(0, 10) : '?'} tak bane)`)
      };
    });

    return {
      kitne_galat: bad.length,
      kul_checklist: chl.length,
      FAISLA: faisla,
      JAANCH: jaanch,
      namune: bad.slice(0, 15).map(b => {
        const t = chl.find(x => String(x.id) === String(b.id)) || {};
        return Object.assign({}, b, {
          assigned_to: t.assigned_to,
          bana: String(t.created_at || '').slice(0, 16),
          kaam: String(t.description || '').slice(0, 45)
        });
      })
    };
  } catch (e) { return { error: e.message }; }
}

// ── "Task daale the, dikh hi nahi rahe" ka jawab ──
// Email ya naam do, aur saaf pata chalta hai: user mila ya nahi, uske kitne
// task hain, kitne AAJ dikhne wale hain aur kitne AAGE KI DATE ke hain.
// Checklist ka main view aaj-se-aage wale task chhupa deta hai, isliye upload
// ke baad aksar lagta hai "task bane hi nahi" -- jabki bane hote hain, bas
// unki date abhi aayi nahi hoti. (15 Sep 2026)
//   /api/cron/wa-reminders?doer=rajpootvishalr11@gmail.com
async function doerJhaank(q) {
  try {
    const d = await getDB();
    const [chl, users] = await Promise.all([d.findAll('Checklist_Tasks'), d.findAll('Users')]);
    const k = String(q || '').trim().toLowerCase();
    if (!k) return { error: 'naam ya email do' };
    const mila = users.filter(u =>
      String(u.email || '').trim().toLowerCase() === k ||
      String(u.name || '').trim().toLowerCase().includes(k));
    if (!mila.length) {
      return {
        MILA: 'NAHI -- is email/naam ka koi user hi nahi hai',
        dhoonda: q,
        iska_matlab: 'Bulk upload aisi rows ko chupchaap skip kar deta hai -- task bante hi nahi'
      };
    }
    const todayStr = today();
    const out = mila.map(u => {
      const mine = chl.filter(t => String(t.assigned_to) === String(u.id));
      const open = mine.filter(t => t.status === 'pending' || t.status === 'revised');
      const aaj  = open.filter(t => String(t.due_date || '') <= todayStr);
      const aage = open.filter(t => String(t.due_date || '') > todayStr);
      const hist = {};
      aage.forEach(t => { const v = String(t.due_date || ''); hist[v] = (hist[v] || 0) + 1; });
      return {
        user: `${u.name} (id ${u.id})`,
        email: u.email,
        week_off: u.week_off || '(koi nahi)',
        kul_checklist: mine.length,
        khule: open.length,
        AAJ_DIKHNE_WALE: aaj.length,
        AAGE_KI_DATE_WALE_abhi_chhupe: aage.length,
        aage_ki_dates: Object.entries(hist).sort().slice(0, 15).map(([dt, n]) => `${dt}: ${n}`),
        sabse_naye_12: mine.slice(-12).map(t => ({
          id: t.id, due_date: t.due_date, freq: t.frequency, status: t.status,
          kaam: String(t.description || '').slice(0, 45)
        }))
      };
    });
    return { aaj: todayStr, kitne_user_mile: out.length, mile: out };
  } catch (e) { return { error: e.message }; }
}

// ── "Ye task kisne diya aur kisne band kiya?" ──
// Naam ka tukda do, task dhoondh kar poora hisaab de deta hai. Delegation
// aur Checklist dono me dekhta hai. Ye sawaal baar-baar aata hai, isliye
// har baar DB kholne ki jagah ek jagah se jawab. (17 Sep 2026)
//   /api/cron/wa-reminders?task=test run
async function taskKaHisaab(q) {
  try {
    const d = await getDB();
    const [del, chl, users] = await Promise.all([
      d.findAll('Delegation_Tasks'), d.findAll('Checklist_Tasks'), d.findAll('Users')
    ]);
    const naam = {};
    users.forEach(u => { naam[String(u.id)] = String(u.name || ''); });
    const k = String(q || '').trim().toLowerCase();
    if (!k) return { error: 'task ka naam ya uska tukda do' };

    // Poora safar: pending -> report -> closed, har padav kisne kiya
    let log = [];
    try { log = await d.findAll('Task_Status_Log'); } catch { /* table abhi nahi bani */ }
    const safarKa = (kism, id) => log
      .filter(l => String(l.task_id) === String(id) && String(l.task_type || '') === kism)
      .sort((a, b) => String(a.changed_at || '').localeCompare(String(b.changed_at || '')))
      .map(l => `${l.from_status || '?'} -> ${l.to_status}  |  ${l.by_name || '(naam nahi)'}  |  ${l.changed_at}`);

    const pick = (rows, kism) => rows
      .filter(t => String(t.description || '').toLowerCase().includes(k))
      .map(t => ({
        kism, id: t.id,
        kaam: String(t.description || '').slice(0, 80),
        KISNE_DIYA: naam[String(t.assigned_by)] || `(id ${t.assigned_by || '-'})`,
        KISE_DIYA: naam[String(t.assigned_to)] || `(id ${t.assigned_to || '-'})`,
        kab_diya: t.created_at || '',
        due_date: t.due_date || '',
        ab_status: t.status || '',
        STATUS_KISNE_BADLA: t.status_changed_by_name
          || (t.status_changed_by ? (naam[String(t.status_changed_by)] || `(id ${t.status_changed_by})`) : '(record nahi)'),
        kab_badla: t.status_changed_at || '(record nahi)',
        doer_ne_report_bheji_thi: String(t.was_reported || '') === '1' ? 'HAAN' : 'nahi',
        POORA_SAFAR: (() => {
          const s = safarKa(kism, t.id);
          return s.length ? s : ['(is task ka safar record nahi hua -- log 17 Sep 2026 se shuru hua hai)'];
        })()
      }));

    const mile = pick(del, 'delegation').concat(pick(chl, 'checklist'));
    if (!mile.length) return { MILA: 'NAHI — is naam ka koi task nahi mila', dhoonda: q };
    // Naya pehle
    mile.sort((a, b) => String(b.kab_diya || '').localeCompare(String(a.kab_diya || '')));
    return { dhoonda: q, kitne_mile: mile.length, mile: mile.slice(0, 10) };
  } catch (e) { return { error: e.message }; }
}

// Kisi ek doer ki checklist rows jhaank kar dekho — sirf id/date/status.
// Description NAHI bhejte (endpoint public hai). Diagnose ke liye:
//   /api/cron/wa-reminders?peek=ravi
async function checklistPeek(name) {
  try {
    const d = await getDB();
    const all = await d.findAll('Checklist_Tasks');
    const q = String(name || '').toLowerCase();
    const mine = all.filter(t => String(t.doer_name || '').toLowerCase().includes(q));
    const open = mine.filter(t => t.status === 'pending' || t.status === 'revised');
    return {
      kul: mine.length,
      khule: open.length,
      khali_date: mine.filter(t => !String(t.due_date == null ? '' : t.due_date).trim()).length,
      ek_hi_din_par: (() => {
        // kaunsi date par kitne task — agar 168 ek hi din par hain to yahin dikh jayega
        const c = {};
        open.forEach(t => { const v = String(t.due_date || '').trim(); c[v] = (c[v] || 0) + 1; });
        return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([dt, n]) => `${dt}: ${n}`);
      })(),
      namune: open.slice(0, 5).map(t => ({
        id: t.id, due_date: t.due_date, kis_kism_ka: typeof t.due_date,
        status: t.status, frequency: t.frequency
      }))
    };
  } catch (e) { return { error: e.message }; }
}

// Checklist ki due_date ka haal — kitni theek, kitni khali/NaN
async function checklistDateHealth() {
  try {
    const d = await getDB();
    const all = await d.findAll('Checklist_Tasks');
    let okc = 0, nan = 0, blank = 0, other = 0;
    const samples = [];
    all.forEach(t => {
      const v = String(t.due_date == null ? '' : t.due_date).trim();
      if (!v) blank++;
      else if (v.includes('NaN')) nan++;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(v)) okc++;
      else { other++; if (samples.length < 3) samples.push(v.slice(0, 30)); }
    });
    return `kul ${all.length} | theek ${okc} | NaN ${nan} | khali ${blank} | ajeeb ${other}` +
           (samples.length ? ` (jaise: ${samples.join(' , ')})` : '');
  } catch { return null; }
}

// Ulti date ka hisaab -- sirf padhta hai: na message bhejta hai, na kuch
// badalta hai. Naam ke alawa task ka koi text bahar nahi jaata.
app.get('/api/cron/date-check', async (req, res) => {
  try {
    const ab = await scanUltiDates();
    res.json({
      pehliBaarJoMila: await appStateValue('checklist_ulti_date_report'),
      abhiBaaki: {
        kul: ab.length,
        checklist: ab.filter(x => x.tab === 'Checklist_Tasks').length,
        delegation: ab.filter(x => x.tab === 'Delegation_Tasks').length,
        khuleTask: ab.filter(x => x.khula).length
      },
      doerWise: ultiGinti(ab),
      puranaFix: await appStateValue('checklist_date_format_fix_v2')
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cron/wa-reminders', async (req, res) => {
  try {
    if (!WA.enabled || !WA.url || !WA.apiKey) return res.json({ skipped: 'not-configured' });
    const ist = new Date(Date.now() + 330 * 60000);
    const istTime = ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
    if (ist.getUTCDay() === 1) {
      // Reminder Monday ko nahi jaate (Harsh ka niyam) — par diagnose ki
      // baatein phir bhi batao, warna Monday ko kuch dekha hi nahi ja sakta
      return res.json({
        skipped: 'monday', now: istTime,
        checklistDateHealth: await checklistDateHealth(),
        checklistOdd: await checklistOddSample(6),
        checklistPeek: req.query.peek ? await checklistPeek(String(req.query.peek)) : undefined,
        orphanDoers: req.query.orphans ? await orphanDoers() : undefined,
        doerMismatch: req.query.mismatch ? await doerMismatch() : undefined,
        casting: req.query.casting ? await castingProbe(await getDB()) : undefined,
        doerJhaank: req.query.doer ? await doerJhaank(String(req.query.doer)) : undefined,
        taskKaHisaab: req.query.task ? await taskKaHisaab(String(req.query.task)) : undefined,
        reminderWho: req.query.who ? await reminderWho() : undefined,
        delegationAudit: req.query.deleg ? await delegationAudit() : undefined,
        tableCols: req.query.cols ? await tableCols() : undefined,
        checklistDateFix: await appStateValue('checklist_blank_date_fix_v3'),
        checklistFormatFix: await appStateValue('checklist_date_format_fix_v2'),
        orphanCleanup: await appStateValue('orphan_open_tasks_removed_v1'),
        keepAlive: _keepAliveUrl ? `ON — har 4 min self-ping (${_keepAliveUrl})` : 'OFF',
        uptime: uptimeText(), pid: process.pid
      });
    }
    // Background me chalao — Aumpfy slow hai (~50s/msg), request ko mat latkao
    checkAndFireDueSlots()
      .then(r => console.log('  WA reminders (cron):', JSON.stringify(r)))
      .catch(e => console.error('  WA reminders (cron) error:', e.message));
    const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const slot = [...waSlots()].sort((a, b) => (b.h * 60 + (b.m || 0)) - (a.h * 60 + (a.m || 0))).find(s => {
      const sm = s.h * 60 + (s.m || 0);
      return nowMin >= sm && nowMin < 19 * 60;   // slot-time se 7 PM tak
    });
    // Aaj us slot ka pass ho chuka ya nahi — diagnose ke liye
    let sentToday = null;
    if (slot) {
      const mk = `wa_pass_${ist.toISOString().split('T')[0]}_${slot.h}${String(slot.m || 0).padStart(2, '0')}`;
      sentToday = await _waSlotDone(mk);
    }
    // Outbox ka haal — assign-time message atke to yahan dikh jayega
    // (sirf ginti, message ka text kabhi expose nahi hota)
    let outbox = null;
    try {
      const d = await getDB();
      const rows = await d.findAll('WA_Outbox');
      outbox = { sent: 0, pending: 0, failed: 0, sending: 0, unknown: 0, expired: 0 };
      rows.forEach(r => { outbox[r.status] = (outbox[r.status] || 0) + 1; });
      // Atke kyun hain — attempts kitni baar ho chuki aur aakhri wajah kya thi
      const stuck = rows.filter(r => r.status === 'pending');
      if (stuck.length) {
        outbox.attempts = stuck.map(r => parseInt(r.attempts) || 0).join(',');
        outbox.lastError = (stuck.find(r => r.last_error) || {}).last_error || _outboxLastError || '(koi error record nahi)';
      }
      outbox.running = _outboxRunning;
      const dn = ['default', 'pms'].filter(n => waBreakerOpen(n));
      if (dn.length) outbox.aumpfyDown = dn.join(' + ') + ' band — unke message ruke hain (POST nahi ho rahe)';
    } catch { /* table abhi bani nahi — koi baat nahi */ }
    // Backfill chala ya nahi — bina login diagnose ke liye
    let backfill = null;
    try {
      const d = await getDB();
      const rows = await d.findWhere('App_State', { key_name: 'wa_backfill_missed_assign_v1' });
      backfill = (rows && rows.length) ? (rows[0].value || 'done') : 'abhi nahi chala';
    } catch { /* koi baat nahi */ }
    // "NaN-NaN-NaN" wali dates ka repair chala ya nahi
    let dateFix = null;
    try {
      const d = await getDB();
      const rows = await d.findWhere('App_State', { key_name: 'checklist_blank_date_fix_v3' });
      dateFix = (rows && rows.length) ? (rows[0].value || 'done') : 'abhi nahi chala';
    } catch { /* koi baat nahi */ }
    // Checklist ki due_date ka haal — kitni theek, kitni khali/NaN.
    // (7 Sep 2026: screen par "—" dikh raha tha par DB me kuch rows theek
    // thin — ginti kiye bina andaza lagana galat tha.)
    const dateHealth = await checklistDateHealth();
    // Atke hue message ab bhej do
    drainWhatsAppOutbox().catch(() => {});

    // Config diagnose (key masked — poori key kabhi expose nahi hoti)
    const k = String(WA.apiKey || '');
    res.json({
      now: istTime,
      slot: slot ? `${slot.h}:${String(slot.m || 0).padStart(2, '0')}` : null,
      sentToday,
      outbox,
      backfill,
      checklistDateFix: dateFix,
      checklistFormatFix: await appStateValue('checklist_date_format_fix_v2'),
      orphanCleanup: await appStateValue('orphan_open_tasks_removed_v1'),
      checklistDateHealth: dateHealth,
      checklistOdd: await checklistOddSample(6),
      checklistPeek: req.query.peek ? await checklistPeek(String(req.query.peek)) : undefined,
      orphanDoers: req.query.orphans ? await orphanDoers() : undefined,
      doerMismatch: req.query.mismatch ? await doerMismatch() : undefined,
      casting: req.query.casting ? await castingProbe(await getDB()) : undefined,
      doerJhaank: req.query.doer ? await doerJhaank(String(req.query.doer)) : undefined,
      taskKaHisaab: req.query.task ? await taskKaHisaab(String(req.query.task)) : undefined,
      reminderWho: req.query.who ? await reminderWho() : undefined,
      delegationAudit: req.query.deleg ? await delegationAudit() : undefined,
      tableCols: req.query.cols ? await tableCols() : undefined,
      status: slot
        ? (sentToday ? 'is slot ka reminder aaj ja chuka hai' : 'slot-window-me-hai (pass chal raha)')
        : 'outside-slot-window',
      config: {
        trigger: String(WA.url || '').split('/').pop(),
        keyMasked: k ? `${k.slice(0, 8)}…${k.slice(-4)} (${k.length} chars)` : 'NOT SET',
        notifyOnAssign: !!WA.notifyOnAssign,
        reminderTimes: waSlots().map(s => `${s.h}:${String(s.m || 0).padStart(2, '0')}`).join(' & ')
      },
      // Self keep-alive: app khud ko jagati rehti hai — iske bina Hostinger
      // app ko sula deta hai aur slot miss ho jaata hai
      keepAlive: _keepAliveUrl
        ? `ON — har ${KEEP_ALIVE_MIN} min self-ping (${_keepAliveUrl})`
        : ((process.env.NODE_ENV || '').toLowerCase() !== 'production'
            ? 'OFF — NODE_ENV production nahi hai'
            : 'OFF — .env me APP_URL set karo, phir restart'),
      keptAlive: true,
      // App kitni der se chal rahi hai + kaunsa process. Subah agar uptime
      // chand minute ka ho, to app raat me soyi thi -- wahi slot miss hone
      // ki asli wajah hai.
      uptime: uptimeText(), pid: process.pid
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually trigger the WhatsApp reminder pass. Runs in the background (the
// Aumpfy API is slow — ~50s/msg), so respond immediately instead of hanging.
// Admin ka manual button — force=true, yaani "aaj bhej chuke" wala marker
// ignore karke bhejta hai (deliberate action hai, isliye).
app.post('/api/admin/run-wa-reminders', requireAuth, requireAdmin, async (req, res) => {
  runWhatsAppReminders(null, true)
    .then(r => console.log('  WA reminders (manual):', JSON.stringify(r)))
    .catch(e => console.error('  WA reminders (manual) error:', e.message));
  res.json({ started: true });
});

// ══════════════════════════════════════════════════════
// CASTING / STONE ENTRY (Harsh, 15 Oct)
// ══════════════════════════════════════════════════════
// Teen Google Form ki sheet ("Casting Entry") ko app me dikhana: Settlement
// Amount, Stone Setting aur Casting Entry. Data seedha Google Sheet se aata
// hai (service account ko sheet share hai) -- koi manual calculation nahi.
//
// Column PDF me jaise likhe hain waise hi liye gaye hain (Stone: V = labour,
// S aur U = silver; Casting: H = labour). Har KPI ke saath ye bhi jaata hai ki
// kaun sa column liya, taaki screen par sheet se milaya ja sake.
//
// ══ CASTING_BLOCK_START ══
const CASTING_SHEET_ID = '1_N8xDXip9S8sCXua02aTTrR5wYApaIhMJ9YlDWidZDo';
// "01/09/2026 se lekar aaj tak" -- isse purani entry kabhi nahi dikhti
const CASTING_FROM = '2026-09-01';
// form: har tab ka Google Form link. Khali ho to screen par button band dikhta
// hai ("link set nahi hai") -- link milte hi yahin bhar do.
const CASTING_TABS = {
  settlement: { title: 'Settlement Amount', exact: 'Settlement Amount', find: /settlement/i, form: '' },
  stone:      { title: 'Stone Setting',     exact: 'Stone setting form', find: /stone/i,      form: '' },
  casting:    { title: 'Casting Entry',     exact: 'Casting Entry Form', find: /casting/i,    form: '' }
};
// Admin ko hamesha, aur is list wale logon ko. Harsh, 15 Oct: Gurjeet aur
// Bappi Ji. Email se milate hain (naam badal sakta hai). Aage kisi ko dena ho
// to yahan email jod do. Dhyan: Google Form ka link sirf admin badal sakta hai.
const CASTING_EMAILS = ['gurjeet-inventory@raabtajewels.com', 'shekhakram655@gmail.com'];
function castingAllowed(user) {
  if (String((user && user.role) || '') === 'admin') return true;
  const em = String((user && user.email) || '').trim().toLowerCase();
  return !!em && CASTING_EMAILS.includes(em);
}

// "V" -> 21,  21 -> "V"
function castCol(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function castLetter(i) {
  let out = '', n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
function castNum(v) {
  const x = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(x) ? x : 0;
}
// Sheet "15/01/2026 11:40:16" (din pehle) ya "2026-01-15" -- dono ko YYYY-MM-DD
function castISO(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = +m[1], mo = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return m[3] + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  return '';
}

// Date filter. Kuch na chuna ho to 01-09-2026 se aaj tak. 01-09 se pehle ki
// taarikh chun lo to bhi wahi se shuru (purani entry dikhani hi nahi).
function castRange(fromQ, toQ, today) {
  let f = castISO(fromQ) || CASTING_FROM;
  let t = castISO(toQ) || today;
  if (f > t) { const x = f; f = t; t = x; }          // ulta bhar diya to seedha
  if (t < CASTING_FROM) return { from: CASTING_FROM, to: CASTING_FROM, none: true };
  if (f < CASTING_FROM) f = CASTING_FROM;
  return { from: f, to: t, none: false };
}

// Tab ka asli naam. Sheet me thoda alag likha ho (bade-chhote akshar, extra
// space) to bhi mil jaye; na mile to saaf bata de ki kaun se tab hain.
const _castTitles = { at: 0, list: [] };
async function castTabTitle(d, kind) {
  if (!_castTitles.list.length || Date.now() - _castTitles.at > 10 * 60000) {
    const r = await withRetry(() => d.sheets.spreadsheets.get({
      spreadsheetId: CASTING_SHEET_ID, fields: 'sheets.properties.title'
    }));
    _castTitles.list = ((r.data && r.data.sheets) || []).map(x => x.properties.title);
    _castTitles.at = Date.now();
  }
  const cfg = CASTING_TABS[kind];
  const norm = x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const t = _castTitles.list.find(x => norm(x) === norm(cfg.exact)) || _castTitles.list.find(x => cfg.find.test(x));
  if (!t) throw new Error('Sheet me "' + cfg.exact + '" naam ka tab nahi mila. Tab ye hain: ' + _castTitles.list.join(', '));
  return t;
}

async function castLoad(d, kind) {
  const title = await castTabTitle(d, kind);
  const quoted = "'" + title.replace(/'/g, "''") + "'";
  const rows = await readSheetCached(d, CASTING_SHEET_ID, quoted + '!A1:ZZ');
  const headers = (rows[0] || []).map(x => String(x == null ? '' : x).trim());
  let last = headers.length;
  while (last > 0 && !headers[last - 1]) last--;
  const data = rows.slice(1).filter(r => r && r.some(c => String(c == null ? '' : c).trim() !== ''));
  return { title, headers: headers.slice(0, last), data, width: last };
}

// Date wala column: "तारीख" / "Date" ho to wahi, nahi to pehla (Timestamp)
function castDateCol(headers) {
  const i = headers.findIndex(h => /तारीख|दिनांक|date/i.test(h));
  return i >= 0 ? i : 0;
}

// Ek column ka jod, chune hue date range ke liye.
// Column "Running Sum" kehlata hai -- do roop ho sakte hain:
//   * har row ka apna jod (846.50, 573.07, 12.40 ...)  -> range ki rows ka SUM
//   * badhta hua cumulative total (100, 250, 480 ...)  -> range ke aakhir ka
//     total MINUS range se theek pehle ka total (warna poora jod bahut zyada aata)
// Pehchaan: lagbhag har step par badhe AUR aadhe se zyada step sach me badhe.
// Kaun sa roop mila, wo "mode" me jaata hai taaki screen par dikhe.
function castColumnTotal(data, idx, dateOf, inR) {
  const seq = [];
  data.forEach(r => {
    const raw = String(r[idx] == null ? '' : r[idx]).trim();
    if (raw === '') return;
    seq.push({ v: castNum(r[idx]), iso: dateOf(r) });
  });
  let cum = false;
  if (seq.length >= 6) {
    let ge = 0, gt = 0;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i].v >= seq[i - 1].v) ge++;
      if (seq[i].v > seq[i - 1].v) gt++;
    }
    const steps = seq.length - 1;
    cum = ge / steps >= 0.98 && gt / steps >= 0.5 && seq[seq.length - 1].v > seq[0].v;
  }
  if (!cum) {
    return { total: seq.filter(x => inR(x.iso)).reduce((a, x) => a + x.v, 0), mode: 'sum', count: seq.length };
  }
  let first = -1, lastIn = -1;
  seq.forEach((x, i) => { if (inR(x.iso)) { if (first < 0) first = i; lastIn = i; } });
  if (first < 0) return { total: 0, mode: 'running', count: seq.length };
  const before = first > 0 ? seq[first - 1].v : 0;
  return { total: seq[lastIn].v - before, mode: 'running', count: seq.length };
}

// Settlement sheet: kis category me kitna diya gaya. Columns ke naam pata
// nahi the, isliye pehchaan data se karte hain:
//   * amount  -> jis column ke header me amount/राशि/रकम/payment aaye
//   * category-> jis column me sabse zyada "Stone"/"Casting" likha ho
// Category column na mile to poori row ka text dekhte hain.
function castSettlement(st, inR, warnings) {
  const headers = st.headers;
  const dateCol = castDateCol(headers);
  const dateOf = r => castISO(r[dateCol]) || castISO(r[0]);

  // Amount: pehle jis header me seedha "amount / राशि / रकम" ho. "payment / paid"
  // sirf tab, jab aisa koi na mile -- warna "Type of payment" (jo category ka
  // column hai) galti se amount ban jaata hai. Asli sheet me yahi hua tha.
  const amtStrong = /amount|राशि|रकम/i;
  const amtWeak = /payment|paid|भुगतान|रुपय/i;
  const catHdrRe = /type|category|प्रकार|श्रेणी|कैटेगरी/i;
  const pick = (re, skipCat) => {
    const a = [];
    headers.forEach((h, i) => { if (i !== dateCol && re.test(h) && !(skipCat && catHdrRe.test(h))) a.push(i); });
    return a;
  };
  let amtCols = pick(amtStrong, false);
  // payment/paid wale header me "Type of payment" (category) kabhi amount nahi
  if (!amtCols.length) amtCols = pick(amtWeak, true);
  const amountCol = amtCols.length ? amtCols[0] : -1;
  if (amtCols.length > 1) {
    warnings.push('Settlement sheet me "amount" jaise ' + amtCols.length + ' column mile (' +
      amtCols.map(i => castLetter(i) + ': ' + headers[i]).join(', ') + ') -- pehla (' + castLetter(amountCol) + ') liya');
  }
  if (amountCol < 0) warnings.push('Settlement sheet me amount ka column nahi mila (header me amount / राशि / रकम / payment dhoondha)');

  // Category: pehle jis header me type / category / प्रकार ho (asli sheet me
  // "Type of payment"). Na mile to data se -- jis column me sabse zyada
  // "Stone"/"Casting" likha ho.
  let catCol = headers.findIndex((h, i) => i > 0 && i !== amountCol && i !== dateCol && catHdrRe.test(h));
  if (catCol < 0) {
    const catRe = /stone|स्टोन|cast|कास्ट/i;
    let best = 0;
    for (let c = 0; c < Math.max(st.width, 1); c++) {
      if (c === amountCol) continue;
      let k = 0;
      st.data.forEach(r => { if (catRe.test(String(r[c] == null ? '' : r[c]))) k++; });
      if (k > best) { best = k; catCol = c; }
    }
  }

  const given = { stone: 0, casting: 0, other: 0, all: 0, stoneN: 0, castingN: 0, otherN: 0 };
  const unmapped = new Set();
  st.data.forEach(r => {
    if (!inR(dateOf(r))) return;
    const amt = amountCol >= 0 ? castNum(r[amountCol]) : 0;
    const text = catCol >= 0 ? String(r[catCol] == null ? '' : r[catCol]) : r.join(' ');
    const kind = /stone|स्टोन/i.test(text) ? 'stone' : (/cast|कास्ट/i.test(text) ? 'casting' : 'other');
    given[kind] += amt; given[kind + 'N']++; given.all += amt;
    if (kind === 'other' && unmapped.size < 6) unmapped.add((String(text).trim() || '(khali)').slice(0, 40));
  });
  given.unmapped = Array.from(unmapped);

  const cats = [];
  if (catCol >= 0) {
    const seen = new Set();
    st.data.forEach(r => { const v = String(r[catCol] == null ? '' : r[catCol]).trim(); if (v && seen.size < 12) seen.add(v.slice(0, 40)); });
    cats.push(...seen);
  }
  return {
    given, dateCol, amountCol, catCol, dateOf, categories: cats,
    mapping: {
      date: castLetter(dateCol) + (headers[dateCol] ? ' (' + headers[dateCol] + ')' : ''),
      amount: amountCol >= 0 ? castLetter(amountCol) + ' (' + headers[amountCol] + ')' : null,
      category: catCol >= 0 ? castLetter(catCol) + (headers[catCol] ? ' (' + headers[catCol] + ')' : '') : 'poori row ka text'
    }
  };
}

// Silver tab ke OUT entry jinka Karigar/Doer "Bappi" hai -- unka silver ka jod
async function castSilverIssue(d, inR) {
  const rows = await d.findAll('Silver_Stock').catch(() => []);
  let total = 0, count = 0;
  rows.forEach(r => {
    if (String(r.entry_type || '').toUpperCase() !== 'OUT') return;
    if (String(r.to_karigar || '').toLowerCase() === 'no') return;   // karigar ko nahi diya
    if (!/bappi/i.test(String(r.vendor || ''))) return;
    if (!inR(String(r.entry_date || '').slice(0, 10))) return;
    total += castNum(r.weight); count++;
  });
  return { total, count };
}

// Google Form ka link. PDF me links nahi the, isliye admin app se hi daal sakta
// hai (App_State me rakha jaata hai) -- redeploy ki zaroorat nahi. Sirf asli
// Google Form ka link maana jaata hai, kuch bhi nahi (javascript: wagairah).
const CAST_FORM_RE = /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/|forms\.google\.com\/)\S+$/i;
async function castFormUrl(d, kind) {
  try {
    if (typeof d.findWhere === 'function') {
      const rows = await d.findWhere('App_State', { key_name: 'casting_form_' + kind });
      const v = rows && rows[0] ? String(rows[0].value || '').trim() : '';
      if (v && CAST_FORM_RE.test(v)) return v;
    }
  } catch (e) { /* link na padh paye to config wala (khali) */ }
  return CASTING_TABS[kind].form || '';
}
// Khali url = link hata do
async function castSaveFormUrl(d, kind, raw) {
  const url = String(raw == null ? '' : raw).trim();
  if (url && (url.length > 500 || !CAST_FORM_RE.test(url))) {
    const err = new Error('Ye Google Form ka link nahi lagta (docs.google.com/forms/... ya forms.gle/... hona chahiye)');
    err.status = 400;
    throw err;
  }
  const key = 'casting_form_' + kind;
  const rows = await d.findWhere('App_State', { key_name: key });
  const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];
  if (rows && rows.length) await d.update('App_State', rows[0].id, { value: url, updated_at: nowStr });
  else await d.insert('App_State', { key_name: key, value: url, updated_at: nowStr });
  return url;
}

// Ek tab ka poora jawab: rows (date ke hisaab se chhaanti hui), KPI, aur ye
// ki kaun sa column liya. kind = settlement | stone | casting
async function castingBuild(d, kind, fromQ, toQ) {
  const cfg = CASTING_TABS[kind];
  const today = new Date(Date.now() + 330 * 60000).toISOString().split('T')[0];
  const R = castRange(fromQ, toQ, today);
  const inR = iso => !R.none && !!iso && iso >= R.from && iso <= R.to;
  const warnings = [];

  const main = await castLoad(d, kind);
  const dateCol = castDateCol(main.headers);
  const dateOf = r => castISO(r[dateCol]) || castISO(r[0]);
  const used = [];                         // KPI me jo columns lage
  const kpis = [];

  // Settlement sheet: settlement tab me wahi, baaki dono tab me alag se padhte hain
  let S = null;
  if (kind === 'settlement') {
    S = castSettlement(main, inR, warnings);
  } else {
    try { S = castSettlement(await castLoad(d, 'settlement'), inR, warnings); }
    catch (e) { warnings.push('Settlement tab padh nahi paya, isliye "Amount Given" nahi dikha sakte: ' + e.message); }
  }
  const checkCol = (letter, what) => {
    const i = castCol(letter);
    if (main.headers.length && i >= Math.max(main.width, ...main.data.map(r => r.length))) {
      warnings.push('Sheet me column ' + letter + ' nahi hai (' + what + ')');
    }
    used.push(i);
    return i;
  };
  const colName = i => castLetter(i) + (main.headers[i] ? ' (' + main.headers[i] + ')' : '');
  const modeNote = t => t.mode === 'running' ? 'cumulative column: range ka antar liya' : 'range ki rows ka jod';

  if (kind === 'settlement') {
    kpis.push({ label: 'Total Settlement Given', value: S.given.all, kind: 'money', tone: 'out',
                sub: (S.given.stoneN + S.given.castingN + S.given.otherN) + ' entries' });
    kpis.push({ label: 'Stone Setting', value: S.given.stone, kind: 'money', tone: 'balance', sub: S.given.stoneN + ' entries' });
    kpis.push({ label: 'Casting Setting', value: S.given.casting, kind: 'money', tone: 'in', sub: S.given.castingN + ' entries' });
    if (S.given.otherN) kpis.push({ label: 'Other / unmapped', value: S.given.other, kind: 'money', tone: 'out',
      sub: S.given.otherN + ' entries -- category pehchaani nahi gayi: ' + S.given.unmapped.join(', ') });
  }

  if (kind === 'stone') {
    const vI = checkCol('V', 'labour'), sI = checkCol('S', 'silver'), uI = checkCol('U', 'silver');
    const labour = castColumnTotal(main.data, vI, dateOf, inR);
    const sT = castColumnTotal(main.data, sI, dateOf, inR);
    const uT = castColumnTotal(main.data, uI, dateOf, inR);
    const silverUsed = sT.total * 0.95 + uT.total;
    const given = S ? S.given.stone : null;
    kpis.push({ label: 'Total Labour Amount', value: labour.total, kind: 'money', tone: 'balance',
                sub: 'column ' + colName(vI) + ' -- ' + modeNote(labour) });
    kpis.push({ label: 'Total Amount Given', value: given, kind: 'money', tone: 'in',
                sub: 'Settlement me sirf "Stone Setting"' });
    kpis.push({ label: 'Outstanding Labour', value: given == null ? null : labour.total - given, kind: 'money', tone: 'out',
                sub: 'labour - amount given' });
    kpis.push({ label: 'Total Silver Used', value: silverUsed, kind: 'weight', tone: 'balance',
                sub: '(S ' + (sT.total).toFixed(3) + ' x 0.95) + U ' + (uT.total).toFixed(3) });
    const si = await castSilverIssue(d, inR);
    kpis.push({ label: 'Silver Issue', value: si.total, kind: 'weight', tone: 'out',
                sub: 'Silver tab: Bappi ko OUT (' + si.count + ' entries)' });
  }

  if (kind === 'casting') {
    const hI = checkCol('H', 'labour');
    const labour = castColumnTotal(main.data, hI, dateOf, inR);
    const given = S ? S.given.casting : null;
    kpis.push({ label: 'Total Labour Amount', value: labour.total, kind: 'money', tone: 'balance',
                sub: 'column ' + colName(hI) + ' -- ' + modeNote(labour) });
    kpis.push({ label: 'Total Amount Given', value: given, kind: 'money', tone: 'in',
                sub: 'Settlement me sirf "Casting Setting"' });
    kpis.push({ label: 'Outstanding Labour', value: given == null ? null : labour.total - given, kind: 'money', tone: 'out',
                sub: 'labour - amount given' });
  }

  const width = Math.max(main.width, ...used.map(i => i + 1), 0);
  const headers = [];
  for (let i = 0; i < width; i++) headers.push(main.headers[i] || ('(' + castLetter(i) + ')'));
  const rows = main.data
    .map((r, idx) => ({ iso: dateOf(r), idx, cells: headers.map((_, i) => String(r[i] == null ? '' : r[i])) }))
    .filter(x => inR(x.iso))
    .sort((a, b) => (a.iso < b.iso ? 1 : a.iso > b.iso ? -1 : b.idx - a.idx))
    .slice(0, 3000)
    .map(x => ({ date: x.iso, cells: x.cells }));

  return {
    kind, title: cfg.title, formUrl: await castFormUrl(d, kind),
    from: R.from, to: R.to, minFrom: CASTING_FROM,
    headers, rows, total: rows.length, kpis, warnings,
    mapping: {
      tab: main.title, dateColumn: castLetter(dateCol) + (main.headers[dateCol] ? ' (' + main.headers[dateCol] + ')' : ''),
      settlement: S ? S.mapping : null
    }
  };
}

// Sirf ye dekhne ke liye ki sheet ka dhaancha kaisa mila -- column ke naam,
// kaun sa column kaise pehchana gaya. Koi rakam ya entry nahi bhejta.
async function castingProbe(d) {
  const out = {};
  for (const kind of Object.keys(CASTING_TABS)) {
    try {
      const m = await castLoad(d, kind);
      const dateCol = castDateCol(m.headers);
      const dateOf = r => castISO(r[dateCol]) || castISO(r[0]);
      const dates = m.data.map(dateOf).filter(Boolean).sort();
      const info = {
        tab: m.title, entries: m.data.length,
        pehli_date: dates[0] || null, aakhri_date: dates[dates.length - 1] || null,
        columns: m.headers.map((h, i) => castLetter(i) + ': ' + (h || '(khali)')),
        date_column: castLetter(dateCol)
      };
      const colsToCheck = kind === 'stone' ? ['S', 'U', 'V'] : (kind === 'casting' ? ['H'] : []);
      info.kpi_columns = colsToCheck.map(L => {
        const i = castCol(L);
        const t = castColumnTotal(m.data, i, dateOf, () => true);
        return L + ': ' + (m.headers[i] || '(header khali)') + ' -- ' + (i < Math.max(m.width, 1) || m.data.some(r => r[i] != null) ? ('mode=' + t.mode + ', ' + t.count + ' bhari cell') : 'COLUMN SHEET ME NAHI HAI');
      });
      if (kind === 'settlement') {
        const w = [];
        const S = castSettlement(m, () => true, w);
        info.settlement_mapping = S.mapping;
        info.categories_mile = S.categories;
        info.warnings = w;
      }
      out[kind] = info;
    } catch (e) { out[kind] = { error: e.message }; }
  }
  return out;
}
// ══ CASTING_BLOCK_END ══

app.get('/api/casting/:kind', requireAuth, async (req, res) => {
  try {
    const kind = String(req.params.kind || '').toLowerCase();
    if (!CASTING_TABS[kind]) return res.status(400).json({ error: 'Galat tab' });
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!castingAllowed(me)) return res.status(403).json({ error: 'Not allowed' });
    if (!d.sheets) return res.status(503).json({ error: 'Google Sheets abhi connect nahi hai' });
    res.json(await castingBuild(d, kind, req.query.from, req.query.to));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Form ka link badlo -- sirf admin
app.put('/api/casting/:kind/form', requireAuth, requireAdmin, async (req, res) => {
  try {
    const kind = String(req.params.kind || '').toLowerCase();
    if (!CASTING_TABS[kind]) return res.status(400).json({ error: 'Galat tab' });
    const d = await getDB();
    await ensureAppStateTab(d);
    const url = await castSaveFormUrl(d, kind, (req.body || {}).url);
    res.json({ success: true, url });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// GOLD SYSTEM — Gold Stock + Gold Wire Stock
// ══════════════════════════════════════════════════════
// Dono khaate ek jaise hain, isliye ek hi set of endpoints dono ko chalata
// hai. URL me kaun sa khaata hai wo :kind batata hai.
const GOLD_TABS = { stock: 'Gold_Stock', wire: 'Gold_Wire_Stock', silver: 'Silver_Stock' };
function goldTable(kind) { return GOLD_TABS[String(kind || '').toLowerCase()] || ''; }

// "0.560" / "0.560 g" / khali -- sab se number nikal lo
function goldNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}

// Gold System kise dikhe. Admin ko hamesha, aur is list wale logon ko --
// Harsh, 13 Oct: "sirf admin aur Gurjeet ko"; 14 Oct: Ashok Sn bhi
// (ashok@raabtajewels.com). Email se milate hain, naam se
// nahi: naam badal sakta hai, email nahi. Aage kisi aur ko dena ho to bas
// yahan email jod do (app.html ka nav flag server ke isi jawab se chalta hai).
const GOLD_EMAILS = ['gurjeet-inventory@raabtajewels.com', 'ashok@raabtajewels.com'];
function goldAllowed(user) {
  if (String((user && user.role) || '') === 'admin') return true;
  const em = String((user && user.email) || '').trim().toLowerCase();
  return !!em && GOLD_EMAILS.includes(em);
}

// Ek row ko screen ke layak banao -- image_data kabhi list me nahi bhejte,
// wo bhaari hota hai (Maintenance me yahi tareeka hai).
function goldRowOut(r) {
  return {
    id: r.id,
    type: (String(r.entry_type || 'IN').toUpperCase() === 'OUT') ? 'OUT' : 'IN',
    date: r.entry_date || '',
    weight: goldNum(r.weight),
    karat: r.karat || '',
    rate: r.rate === '' || r.rate == null ? '' : goldNum(r.rate),
    vendor: r.vendor || '',
    // OUT par "Karigar ko diya?" -- purani entry me khali (= jaisa pehle tha, yes)
    toKarigar: String(r.to_karigar || '').toLowerCase() === 'no' ? 'no' : (String(r.entry_type || '').toUpperCase() === 'OUT' ? 'yes' : ''),
    remarks: r.remarks || '',
    hasImage: !!(r.image_data && String(r.image_data).length > 10),
    imageName: r.image_name || '',
    by: r.created_by_name || '',
    createdAt: r.created_at || ''
  };
}

app.get('/api/gold/:kind', requireAuth, async (req, res) => {
  try {
    const tab = goldTable(req.params.kind);
    if (!tab) return res.status(400).json({ error: 'Galat khaata' });
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!goldAllowed(me)) return res.status(403).json({ error: 'Not allowed' });

    const raw = await d.findAll(tab).catch(() => []);
    const rows = raw.map(goldRowOut)
      // nayi entry sabse upar; ek hi din ki ho to baad me bani pehle
      .sort((a, b) => String(b.date).localeCompare(String(a.date))
                   || String(b.createdAt).localeCompare(String(a.createdAt)));
    const totalIn = rows.filter(r => r.type === 'IN').reduce((s, r) => s + r.weight, 0);
    const totalOut = rows.filter(r => r.type === 'OUT').reduce((s, r) => s + r.weight, 0);
    // "Karigar ko diya?" No wali OUT (Harsh, 22 Oct): sirf Total OUT me judti
    // hai, Current Balance se NAHI ghatti. Balance = IN - (Yes wali OUT).
    const noRows = rows.filter(r => r.type === 'OUT' && r.toKarigar === 'no');
    const totalOutNo = noRows.reduce((s, r) => s + r.weight, 0);
    res.json({ rows, totalIn, totalOut, totalOutNo, countOutNo: noRows.length, balance: totalIn - (totalOut - totalOutNo) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Photo alag se -- list ko bhaari nahi karte
app.get('/api/gold/:kind/:id/image', requireAuth, async (req, res) => {
  try {
    const tab = goldTable(req.params.kind);
    if (!tab) return res.status(400).json({ error: 'Galat khaata' });
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!goldAllowed(me)) return res.status(403).json({ error: 'Not allowed' });
    const row = await d.findOne(tab, { id: String(req.params.id) });
    if (!row || !row.image_data) return res.status(404).json({ error: 'Photo nahi hai' });
    res.json({ name: row.image_name || '', type: row.image_type || '', data: row.image_data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Nayi entry ke fields -- add aur edit dono yahin se bante hain, taaki
// dono jagah ek hi niyam lage
function goldFields(body, kind) {
  const type = (String(body.type || 'IN').toUpperCase() === 'OUT') ? 'OUT' : 'IN';
  // Gold/Wire: naam sirf OUT me (Vendor). Silver: dono me (IN = Vendor,
  // OUT = Karigar) -- isliye wahan IN ka naam girana galat hoga.
  // OUT me "Karigar ko diya?" (Harsh, 22 Oct): Yes = jaisa pehle tha (naam ke
  // saath). No = seedha Total OUT, naam nahi rakhte. Purana page (jisme ye
  // sawaal nahi) kuch na bheje to Yes -- yaani pehle jaisa hi.
  const toKarigar = type === 'OUT' ? (String(body.toKarigar || '').toLowerCase() === 'no' ? 'no' : 'yes') : '';
  const naamChahiye = ((String(kind) === 'silver') || (type === 'OUT')) && toKarigar !== 'no';
  return {
    entry_type: type,
    entry_date: String(body.date || '').trim(),
    weight: String(goldNum(body.weight)),
    karat: String(body.karat || '').trim().slice(0, 28),
    rate: String(body.rate || '').trim() === '' ? '' : String(goldNum(body.rate)),
    vendor: naamChahiye ? String(body.vendor || '').trim().slice(0, 190) : '',
    to_karigar: toKarigar,
    remarks: String(body.remarks || '').trim()
  };
}

function goldCheck(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.entry_date)) return 'Date sahi daalo';
  if (goldNum(f.weight) <= 0) return 'Weight 0 se zyada hona chahiye';
  return '';
}

app.post('/api/gold/:kind', requireAuth, async (req, res) => {
  try {
    const tab = goldTable(req.params.kind);
    if (!tab) return res.status(400).json({ error: 'Galat khaata' });
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!goldAllowed(me)) return res.status(403).json({ error: 'Not allowed' });

    const f = goldFields(req.body || {}, req.params.kind);
    const bura = goldCheck(f);
    if (bura) return res.status(400).json({ error: bura });

    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];
    const b = req.body || {};
    const row = await d.insert(tab, Object.assign({}, f, {
      image_name: String(b.imageName || '').slice(0, 250),
      image_type: String(b.imageType || '').slice(0, 110),
      image_data: String(b.imageData || ''),
      created_by: String(req.session.userId || ''),
      created_by_name: String(req.session.name || ''),
      created_at: nowStr
    }));
    res.json({ success: true, id: row && row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/gold/:kind/:id', requireAuth, async (req, res) => {
  try {
    const tab = goldTable(req.params.kind);
    if (!tab) return res.status(400).json({ error: 'Galat khaata' });
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!goldAllowed(me)) return res.status(403).json({ error: 'Not allowed' });

    const f = goldFields(req.body || {}, req.params.kind);
    const bura = goldCheck(f);
    if (bura) return res.status(400).json({ error: bura });

    const upd = Object.assign({}, f);
    // Nayi photo aayi to hi badlo -- warna purani jyun ki tyun rehni chahiye
    const b = req.body || {};
    if (b.imageData) {
      upd.image_name = String(b.imageName || '').slice(0, 250);
      upd.image_type = String(b.imageType || '').slice(0, 110);
      upd.image_data = String(b.imageData);
    }
    await d.update(tab, String(req.params.id), upd);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/gold/:kind/:id', requireAuth, async (req, res) => {
  try {
    const tab = goldTable(req.params.kind);
    if (!tab) return res.status(400).json({ error: 'Galat khaata' });
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    if (!goldAllowed(me)) return res.status(403).json({ error: 'Not allowed' });
    await d.delete(tab, String(req.params.id));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// MAINTENANCE — Ashok kumar ka "Office Cash" hisaab
// ══════════════════════════════════════════════════════
// AANA (credit): Delhi Sales Form ke "Purchase_System" tab se apne aap.
//   Row tabhi ginti hai jab:  B col me "Ashok kumar"  AUR  F col = "Office Cash"
//   Amount C col se. Sheet me nayi row aate hi total apne aap badh jaata hai.
// JAANA (debit): Maintenance_Expenses table — app se entry hoti hai.
// Balance = kul aana − kul jaana.
const MAINT_SHEET_ID = '1axEpoebcGsfl7JT_fL1PNLBJIEDNFHMxM4_cSzh5biQ';
const MAINT_TAB = 'Purchase_System';
const MAINT_NAME_MATCH = 'ashok';        // B col me ye shabd ho (chhota-bada farak nahi)
const MAINT_MODE_MATCH = 'office cash';  // F col me ye ho

// Maintenance 2 ka aana usi sheet ke "Deposits" tab se (Harsh, 1 Sep).
// Us tab me:  A = timestamp, B = Amount Deposited, D = Deposit Type
// D me hi naam likha hota hai ("BAPPI", "Taken by Rahul" jaisa). Jis row ke
// D me Bappi/Bajji ka naam ho, wo rakam us bande ke Received me jud jaati hai
// — bilkul waise hi jaise Ashok ka Purchase_System se judta hai.
const MAINT_DEP_TAB = 'Deposits';

// Maintenance 2 ke naam. Withdraw ke waqt in me se koi chuna jaye to entry
// Maintenance 2 me jaati hai (alag hisaab). Naam badalne ho to sirf yahan.
const MAINT_PERSONS = ['Bappi ji', 'Bajji ji'];

// Kaun kya dekh sakta hai (Harsh, 29 Aug):
//   admin  -> dono view (Maintenance + Maintenance 2)
//   Ashok  -> sirf pehla (Maintenance) — office cash uske paas hi rehta hai
//   Bappi / Bajji -> sirf doosra (Maintenance 2), aur usme bhi SIRF apna
//                    hisaab (doosre ka paisa nahi dikhta)
// Naam se pehchante hain — sheet me bhi "Ashok kumar/Ashok Sn" jaise alag-alag
// roop hain, isliye seedha match ke bajaye "naam me ye shabd hai kya" dekhte
// hain, jaise office-cash rows me karte hain.
function maintAccessFor(user) {
  const nm = String((user && user.name) || '').toLowerCase();
  const em = String((user && user.email) || '').toLowerCase();
  const hay = nm + ' ' + em;
  if (String((user && user.role) || '') === 'admin') return { view: 'all', person: '' };
  // Person match — MAINT_PERSONS ka pehla shabd (Bappi / Bajji)
  for (const pn of MAINT_PERSONS) {
    const key = pn.split(' ')[0].toLowerCase();       // "bappi" / "bajji"
    if (hay.includes(key)) return { view: 'person', person: pn };
  }
  // Maintenance (Office Cash) kis-kis ko dikhe. Pehle sirf Ashok ka hisaab
  // tha; Harsh (10 Oct) ne Gurjeet ko bhi jodne ko kaha --
  // gurjeet-inventory@raabtajewels.com. Naam ya email me ye shabd mil jaye to
  // Maintenance ka sidebar aur page khul jata hai.
  const MAINT_MAIN_LOG = ['ashok', 'gurjeet'];
  if (MAINT_MAIN_LOG.some(k => hay.includes(k))) return { view: 'main', person: '' };
  return { view: '', person: '' };
}

// Sheet me likhe naam ko apne list wale naam se milao. "BAPPI ", "bappi ji",
// "Taken by Bajji" — sab chal jaayenge. Na mile to khali.
function maintPersonFromText(txt) {
  const hay = String(txt || '').toLowerCase();
  if (!hay.trim()) return '';
  for (const pn of MAINT_PERSONS) {
    const key = pn.split(' ')[0].toLowerCase();   // "bappi" / "bajji"
    if (hay.includes(key)) return pn;
  }
  return '';
}

// "01/09/2026 17:54:24" ya "2026-09-01" -> "2026-09-01".
// Sheet aur DB ki date ek jaisi ho jaati hai, to list sahi tarah se jamti hai.
function maintDateKey(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);   // DD/MM/YYYY
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  return s.split(' ')[0];
}

// "13,000" / "₹ 1498" / "1498.50" — sabse number nikaalo
function maintNum(raw) {
  const n = parseFloat(String(raw == null ? '' : raw).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Sheet ka data 60 sec cache me — page kholte hi turant khulta hai. Sheet me
// nayi row aane par 1 min ke andar apne aap dikh jaati hai (aur background
// refresh chalta rehta hai, to aksar turant).
const MAINT_CACHE_TTL = 60 * 1000;
let _maintCache = { at: 0, rows: null, inFlight: null };

// Sheet se sirf wahi rows jo Ashok + Office Cash hain.
// Harsh ne SIRF ye teen column bole the — wahi padhte hain:
//   B = naam (Ashok), C = amount, F = payment mode (Office Cash)
// Baaki (D/E/H ke Drive link, I ka Details, K ke Comments) chhoote hain —
// unki zarurat nahi thi aur kheenchne se call dheemi bhi hoti thi.
async function maintFetchCredits() {
  const sheets = await getSheetsClient();
  const resp = await withRetry(() => sheets.spreadsheets.values.batchGet({
    spreadsheetId: MAINT_SHEET_ID,
    ranges: [
      `${MAINT_TAB}!A:C`,       // timestamp, naam, amount
      `${MAINT_TAB}!F:F`,       // payment mode
      `${MAINT_DEP_TAB}!A:D`    // Deposits — timestamp, amount, slip, type(naam)
    ]
  }));
  const vr = resp.data.valueRanges || [];
  const abc = (vr[0] && vr[0].values) || [];
  const fCol = (vr[1] && vr[1].values) || [];
  const dep = (vr[2] && vr[2].values) || [];
  const cell = (col, i) => String(((col[i] || [])[0]) || '').trim();

  const out = [];
  // Row 1 heading hai — usse chhod do
  for (let i = 1; i < abc.length; i++) {
    const r = abc[i] || [];
    const name = String(r[1] || '').trim();        // B — Name of Employee
    const mode = cell(fCol, i);                    // F — Payment Mode
    if (!name.toLowerCase().includes(MAINT_NAME_MATCH)) continue;
    if (mode.toLowerCase() !== MAINT_MODE_MATCH) continue;
    const amount = maintNum(r[2]);                 // C — Amount
    if (!amount) continue;
    out.push({
      sheetRow: i + 1,
      date: String(r[0] || '').trim(),             // A — timestamp
      name,
      mode,                                        // F — Payment Mode
      amount
    });
  }

  // Deposits — jis row ke D col me Bappi/Bajji ka naam ho.
  // 0 wali row bhi rakhte hain: hisaab me kuch nahi jodti, par list me dikhti
  // hai to pata chalta hai entry pahunch gayi.
  const deposits = [];
  for (let i = 1; i < dep.length; i++) {
    const r = dep[i] || [];
    const who = maintPersonFromText(r[3]);        // D — Deposit Type me naam
    if (!who) continue;
    deposits.push({
      sheetRow: i + 1,
      date: maintDateKey(r[0]),                   // A — timestamp
      person: who,
      label: String(r[3] || '').trim(),           // D — jaisa sheet me likha hai
      amount: maintNum(r[1])                      // B — Amount Deposited
    });
  }

  return { credits: out, deposits };
}

// Cache ke saath. Purana data hai to TURANT wahi dete hain aur background me
// taaza kar lete hain — user ko "Loading" nahi dikhta.
async function maintReadCredits(force) {
  const fresh = _maintCache.rows && (Date.now() - _maintCache.at) < MAINT_CACHE_TTL;
  if (!force && fresh) return _maintCache.rows;

  // Purana data maujood hai par baasi — turant wahi do, peeche se refresh
  if (!force && _maintCache.rows) {
    if (!_maintCache.inFlight) {
      _maintCache.inFlight = maintFetchCredits()
        .then(rows => { _maintCache.rows = rows; _maintCache.at = Date.now(); return rows; })
        .catch(e => { console.error('  maintenance refresh fail:', e.message); return _maintCache.rows; })
        .finally(() => { _maintCache.inFlight = null; });
    }
    return _maintCache.rows;
  }

  // Pehli baar — do request ek saath na jaayein
  if (_maintCache.inFlight) return _maintCache.inFlight;
  _maintCache.inFlight = maintFetchCredits()
    .then(rows => { _maintCache.rows = rows; _maintCache.at = Date.now(); return rows; })
    .finally(() => { _maintCache.inFlight = null; });
  return _maintCache.inFlight;
}

// Sheets-DB par tab apne aap nahi banti (MySQL me schema se ban jaati hai) —
// isliye pehli baar me bana dete hain. Dono driver par safe: MySQL me
// findAll chal jaata hai to kuch karna hi nahi padta.
async function ensureMaintenanceTab(d) {
  try {
    await d.findAll('Maintenance_Expenses');
  } catch (e) {
    if (!d.sheets) throw e;                 // MySQL — schema khud sambhalta hai
    const cols = ['id', 'spent_on', 'amount', 'description', 'image_name',
                  'image_type', 'image_data', 'created_by', 'created_by_name', 'created_at'];
    try {
      await withRetry(() => d.sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Maintenance_Expenses' } } }] }
      }));
    } catch (e2) { /* pehle se bani hai — koi baat nahi */ }
    await withRetry(() => d.sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Maintenance_Expenses!A1:${idxToColLetter(cols.length - 1)}1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [cols] }
    }));
    delete d._hdrCache['Maintenance_Expenses'];
    delete d._cache['Maintenance_Expenses'];
  }
}

// Entry kis naam par aur kis khaate me jayegi — role dekh kar.
//   admin  -> jo bheja wahi (dono taraf ki entry daal sakta hai)
//   main   -> Ashok: hamesha Maintenance ka kharch; naam optional (kisko diya)
//   person -> Bappi/Bajji: hamesha APNE khaate se, doosre ke naam par nahi
function maintEntryFor(acc, person, ledger) {
  const p = MAINT_PERSONS.includes(String(person || '').trim()) ? String(person).trim() : '';
  const L = String(ledger || '').trim();
  // Paisa aa raha hai ya ja raha hai. 'in' = Maintenance me jodi rakam,
  // 'm2in' = kisi bande ke apne khaate me jodi rakam.
  const isIn = (L === 'in' || L === 'm2in');
  if (acc.view === 'person') return { person: acc.person, ledger: isIn ? 'm2in' : 'm2' };
  if (acc.view === 'main')   return { person: isIn ? '' : p, ledger: isIn ? 'in' : '' };
  if (L === 'm2in') return { person: p, ledger: p ? 'm2in' : 'in' };
  if (L === 'in')   return { person: '', ledger: 'in' };
  return { person: p, ledger: (L === 'm2' && p) ? 'm2' : '' };
}

// ── BALANCE KAM HO TO RAHUL SIR KO ALERT (Harsh, 1 Sep) ──────────────
// SIRF Maintenance ka balance dekhte hain (Maintenance 2 se koi lena-dena
// nahi). 1000 ya usse neeche aate hi ek message. Dobara-dobara na jaye
// isliye App_State me nishaan rakhte hain — balance wapas upar jaane par
// nishaan hat jaata hai, to agli baar girne par phir alert jayega.
const MAINT_LOW_LIMIT = 1000;
const MAINT_LOW_PHONE = '9810487778';      // Rahul sir
const MAINT_LOW_KEY = 'maint_low_alert';

// Maintenance ka aaj ka hisaab — wahi formula jo cards par dikhta hai
async function maintBalanceNow() {
  const [sheetData, d] = await Promise.all([maintReadCredits(false), getDB()]);
  const credits = (sheetData && sheetData.credits) || [];
  await ensureMaintenanceTab(d).catch(() => {});
  const rows = await d.findAll('Maintenance_Expenses').catch(() => []);

  let totalIn = credits.reduce((s, c) => s + maintNum(c.amount), 0);
  let totalOut = 0;
  rows.forEach(r => {
    const led = String(r.ledger || '').trim();
    const amt = maintNum(r.amount);
    if (led === 'in') totalIn += amt;        // haath se jodi rakam
    else if (led === '') totalOut += amt;    // Maintenance ka kharch
    // 'm2' / 'm2in' / 'dep' kisi bande ka apna khaata — yahan nahi ginte
  });
  return { totalIn, totalOut, balance: totalIn - totalOut };
}

function maintRupees(n) {
  return '\u20B9' + (Number(n) || 0).toLocaleString('en-IN');
}

async function checkMaintLowBalance(why) {
  try {
    const d = await getDB();
    await ensureAppStateTab(d);
    const found = await d.findWhere('App_State', { key_name: MAINT_LOW_KEY });
    const cur = found && found[0];
    const wasLow = String((cur && cur.value) || '').startsWith('low');

    const b = await maintBalanceNow();
    const isLow = b.balance <= MAINT_LOW_LIMIT;
    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];

    if (isLow && !wasLow) {
      const msg =
        '\u26A0\uFE0F *Maintenance Balance Alert*\n\n' +
        'Office Cash ka balance *' + maintRupees(b.balance) + '* reh gaya hai.\n' +
        '(Alert limit: ' + maintRupees(MAINT_LOW_LIMIT) + ')\n\n' +
        // Harsh, 10 Sep 2026: Received/Spent ki do line hata di \u2014 message me
        // sirf abhi ka balance aur limit chahiye, aur kuch nahi.
        '\u2014 Raabta Task Manager';
      await queueWhatsApp(MAINT_LOW_PHONE, msg, 'maint-low',
        'maint-low-' + nowStr.split(' ')[0], 'Rahul Sir');
      const val = 'low|' + b.balance + '|' + nowStr;
      if (cur) await d.update('App_State', cur.id, { value: val, updated_at: nowStr });
      else await d.insert('App_State', { key_name: MAINT_LOW_KEY, value: val, updated_at: nowStr });
      console.log('  \u26A0\uFE0F Maintenance balance ' + b.balance + ' — Rahul sir ko alert bheja (' + (why || '') + ')');
    } else if (!isLow && wasLow) {
      // Balance wapas upar — nishaan hata do, agli baar girne par phir jayega
      const val = 'ok|' + b.balance + '|' + nowStr;
      if (cur) await d.update('App_State', cur.id, { value: val, updated_at: nowStr });
      console.log('  Maintenance balance wapas ' + b.balance + ' — alert dobara chalu');
    }
  } catch (e) {
    console.error('  checkMaintLowBalance error:', e.message);
  }
}

// GET /api/maintenance — cards ka data + dono list (aaya / gaya)
app.get('/api/maintenance', requireAuth, async (req, res) => {
  try {
    const d0 = await getDB();
    const me = await d0.findOne('Users', { id: String(req.session.userId) });
    const acc = maintAccessFor(me);
    if (!acc.view) return res.status(403).json({ error: 'Not allowed' });

    const force = String(req.query.refresh || '') === '1';
    const [sheetData, d] = await Promise.all([maintReadCredits(force), getDB()]);
    const credits = (sheetData && sheetData.credits) || [];
    const sheetDeposits = (sheetData && sheetData.deposits) || [];
    await ensureMaintenanceTab(d).catch(() => {});
    const rawExp = await d.findAll('Maintenance_Expenses').catch(() => []);
    // image_data list me NAHI bhejte — page bhaari ho jaata hai. Alag
    // endpoint se maangte hain jab dekhna ho.
    const allExp = rawExp.map(e => ({
      id: e.id,
      spentOn: e.spent_on || '',
      amount: maintNum(e.amount),
      description: e.description || '',
      person: (e.person || '').trim(),
      ledger: (e.ledger || '').trim(),
      hasImage: !!(e.image_data && String(e.image_data).length > 10),
      imageName: e.image_name || '',
      by: e.created_by_name || '',
      createdAt: e.created_at || ''
    })).sort((a, b) => String(b.spentOn || b.createdAt).localeCompare(String(a.spentOn || a.createdAt)));

    // MAINTENANCE ka Spent = wo rows jo Maintenance se nikli (ledger khali).
    // Maintenance 2 se nikli rows (ledger 'm2') yahan NAHI aati — wo paisa
    // pehle hi ghat chuka jab wo Maintenance se us bande ko diya gaya tha.
    const expenses = allExp.filter(e => e.ledger === '');

    // Deposits sheet ki rows ko app ki rows jaisa hi bana dete hain, taaki
    // Maintenance 2 ki Received list me dono ek saath dikhein.
    // id "dep-" se shuru hoti hai — ye DB ki row nahi hai, isliye ise app se
    // mitaya nahi ja sakta (sheet me theek karni ho to sheet me karo).
    const depositRows = sheetDeposits.map(dp => ({
      id: 'dep-' + dp.sheetRow,
      spentOn: dp.date,
      amount: dp.amount,
      description: dp.label ? ('Deposit — ' + dp.label) : 'Deposit',
      person: dp.person,
      ledger: 'dep',          // 'm2' nahi, isliye Received me ginti hai
      hasImage: false, imageName: '',
      by: 'Deposits sheet', createdAt: dp.date,
      fromSheet: true
    }));

    // 'in' Maintenance ki apni jodi hui rakam hai — kisi bande ka hisaab nahi
    const personExpenses = allExp.filter(e => e.person && e.ledger !== 'in')
      .concat(depositRows)
      .sort((a, b) => String(b.spentOn || b.createdAt).localeCompare(String(a.spentOn || a.createdAt)));

    // Haath se jodi rakam ko sheet wali row jaisa hi bana dete hain, taaki
    // Received ki list me dono ek saath, ek jaisi dikhein
    const manualCredits = allExp.filter(e => e.ledger === 'in').map(e => ({
      date: e.spentOn, name: e.description || 'Added by hand',
      mode: 'Added by hand', amount: e.amount,
      id: e.id, manual: true, by: e.by
    }));
    // Nayi entry sabse upar — haath se jodi hui pehle, phir sheet ki
    const allCredits = manualCredits.concat(credits.slice().reverse());

    const totalIn = allCredits.reduce((s, c) => s + c.amount, 0);
    const totalOut = expenses.reduce((s, e) => s + e.amount, 0);

    // Har naam ka apna chhota khaata:
    //   received = Maintenance se uske naam par jo nikla
    //   spent    = Maintenance 2 se usne jo kharch kiya
    //   balance  = uske paas kitna bacha
    const ledgers = {};
    MAINT_PERSONS.forEach(n => { ledgers[n] = { received: 0, spent: 0, balance: 0 }; });
    personExpenses.forEach(e => {
      const L = ledgers[e.person] || (ledgers[e.person] = { received: 0, spent: 0, balance: 0 });
      if (e.ledger === 'm2') L.spent += e.amount; else L.received += e.amount;
    });
    Object.values(ledgers).forEach(L => { L.balance = L.received - L.spent; });

    // Bappi/Bajji ko SIRF apna hisaab — doosre ka paisa, aur Maintenance ka
    // poora khaata, unhe nahi dikhta. Ashok ko Maintenance dikhta hai.
    if (acc.view === 'person') {
      const mine = personExpenses.filter(e => e.person === acc.person);
      const L = ledgers[acc.person] || { received: 0, spent: 0, balance: 0 };
      return res.json({
        maintView: 'person', myPerson: acc.person,
        totalIn: 0, totalOut: 0, balance: 0, credits: [], expenses: [],
        persons: [acc.person],
        personExpenses: mine,
        personLedgers: { [acc.person]: L },
        personReceivedTotal: L.received,
        personSpentTotal: L.spent,
        personBalanceTotal: L.balance
      });
    }

    res.json({
      maintView: acc.view, myPerson: '',
      totalIn, totalOut, balance: totalIn - totalOut,
      credits: allCredits,   // haath se jodi hui + sheet wali, nayi upar
      expenses,
      persons: MAINT_PERSONS,
      personExpenses,
      personLedgers: ledgers,
      personReceivedTotal: Object.values(ledgers).reduce((s, L) => s + L.received, 0),
      personSpentTotal: Object.values(ledgers).reduce((s, L) => s + L.spent, 0),
      personBalanceTotal: Object.values(ledgers).reduce((s, L) => s + L.balance, 0)
    });
  } catch (err) {
    console.error('  /api/maintenance error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/maintenance/expense/:id/image — bill/photo alag se
app.get('/api/maintenance/expense/:id/image', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const me = await d.findOne('Users', { id: String(req.session.userId) });
    const acc = maintAccessFor(me);
    if (!acc.view) return res.status(403).json({ error: 'Not allowed' });
    const row = await d.findOne('Maintenance_Expenses', { id: req.params.id });
    if (!row || !row.image_data) return res.status(404).json({ error: 'Image nahi mili' });
    // Bappi/Bajji sirf apni entry ka bill dekh sakte hain
    if (acc.view === 'person' && String(row.person || '') !== acc.person) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    res.json({ name: row.image_name || 'bill', type: row.image_type || '', data: row.image_data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/maintenance/expense — naya kharch
// Admin ke saath doer bhi entry daal sakte hain (Harsh, 1 Sep): Ashok
// Maintenance ke balance se, Bappi/Bajji apne hi khaate se. Kaun kaunsi
// entry daal sakta hai ye SERVER yahin tay karta hai — browser ke bheje
// ledger/person par bharosa nahi, warna koi bhi doosre ke naam par nikal le.
app.post('/api/maintenance/expense', requireAuth, async (req, res) => {
  try {
    const d0 = await getDB();
    const me = await d0.findOne('Users', { id: String(req.session.userId) });
    const acc = maintAccessFor(me);
    if (!acc.view) return res.status(403).json({ error: 'Not allowed' });

    const { spentOn, amount, description, imageName, imageType, imageData, person, ledger } = req.body || {};
    const amt = maintNum(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Amount sahi daalo' });
    if (!String(description || '').trim()) return res.status(400).json({ error: 'Kahan lagaya — ye likhna zaroori hai' });

    const d = await getDB();
    await ensureMaintenanceTab(d);
    const nowStr = new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').split('.')[0];
    const row = await d.insert('Maintenance_Expenses', {
      spent_on: String(spentOn || '').trim() || nowStr.split(' ')[0],
      amount: String(amt),
      description: String(description).trim(),
      // Naam aur khaata — role dekh kar server khud tay karta hai
      person: maintEntryFor(acc, person, ledger).person,
      // 'm2' tabhi jab naam bhi ho — bina naam ke Maintenance 2 ki entry
      // ban hi nahi sakti (kiske khaate se katega?)
      ledger: maintEntryFor(acc, person, ledger).ledger,
      image_name: String(imageName || '').slice(0, 250),
      image_type: String(imageType || '').slice(0, 110),
      image_data: String(imageData || ''),
      created_by: String(req.session.userId || ''),
      created_by_name: String(req.session.name || ''),
      created_at: nowStr
    });
    res.json({ success: true, id: row && row.id });
    // Entry ke turant baad dekh lo — balance limit se neeche to nahi gaya.
    // Jawab bhej chuke hain, isliye user ko rukna nahi padta.
    checkMaintLowBalance('nayi entry ke baad').catch(() => {});
  } catch (err) {
    console.error('  maintenance expense add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/maintenance/expense/:id — galat entry hataane ke liye (admin)
app.delete('/api/maintenance/expense/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    await d.delete('Maintenance_Expenses', req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/wa-outbox — assign-time messages ka hisaab: kitne gaye,
// kitne atke, aur jo fail hue unki wajah. ?retry=1 se failed dobara try.
app.get('/api/admin/wa-outbox', requireAuth, requireAdmin, async (req, res) => {
  try {
    const d = await getDB();
    let rows = await d.findAll('WA_Outbox');
    if (String(req.query.retry || '') === '1') {
      // Give-up ho chuke messages ko dobara mauka do
      const failed = rows.filter(r => r.status === 'failed');
      for (const r of failed) await d.update('WA_Outbox', r.id, { status: 'pending', attempts: '0', last_error: '' });
      drainWhatsAppOutbox().catch(() => {});
      rows = await d.findAll('WA_Outbox');
    }
    const counts = { sent: 0, pending: 0, failed: 0 };
    rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const recent = rows
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 40)
      .map(r => ({
        person: r.person, phone: r.phone, kind: r.kind, status: r.status,
        attempts: parseInt(r.attempts) || 0, error: r.last_error || '',
        createdAt: r.created_at, sentAt: r.sent_at || ''
      }));
    res.json({
      counts, total: rows.length, recent,
      note: counts.failed ? 'Failed wale dobara bhejne ke liye is URL me ?retry=1 lagao' : 'Sab theek'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/wa-diagnose?phone=9516896449
// "Is number par reminder kyun nahi gaya?" — ek jagah pura jawab. Kuch bhejta
// nahi, sirf batata hai. Har wo condition check karta hai jo reminder rokti hai.
app.get('/api/admin/wa-diagnose', requireAuth, requireAdmin, async (req, res) => {
  try {
    const raw = String(req.query.phone || '').trim();
    if (!raw) return res.status(400).json({ error: 'phone query param chahiye, jaise ?phone=9516896449' });
    const want = normalizePhone(raw);

    const d = await getDB();
    const ist = new Date(Date.now() + 330 * 60000);
    const istDate = ist.toISOString().split('T')[0];
    const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();

    const users = await d.findAll('Users');
    const matches = users.filter(u => normalizePhone(u.phone) === want);

    const reasons = [];
    if (!WA.enabled) reasons.push('WhatsApp disabled hai (config me enabled:false)');
    if (!WA.url || !WA.apiKey) reasons.push('WhatsApp API configure nahi hai');
    if (ist.getUTCDay() === 1) reasons.push('Aaj Monday hai — Monday ko reminders nahi jaate (Harsh ka confirm kiya niyam)');
    if (nowMin < 615) reasons.push(`Abhi ${ist.toISOString().slice(11,16)} IST hai — pehla slot 10:15 par hai, abhi tak chala hi nahi`);
    if (nowMin >= 1140) reasons.push('7 PM ke baad reminders nahi jaate');

    let userInfo = null;
    if (!matches.length) {
      reasons.push(`Ye number kisi bhi USER ka nahi hai (Users me ${users.length} users hain). Reminder sirf app ke users ko jaate hain — customer/FMS sheet ke numbers par kabhi nahi.`);
    } else {
      const cutoff = new Date(Date.now() + 2 * 864e5).toISOString().split('T')[0];
      const todayStr = new Date().toISOString().split('T')[0];
      const [del, chl] = await Promise.all([
        d.findAll('Delegation_Tasks'), d.findAll('Checklist_Tasks')
      ]);
      // Reminder ka asli filter (runWhatsAppReminders jaisa hi)
      const qualifies = t => t.status === 'pending' && t.due_date && t.due_date <= cutoff;

      userInfo = matches.map(u => {
        const mine = t => String(t.assigned_to) === String(u.id);
        const myDel = del.filter(mine), myChl = chl.filter(mine);
        const eligible = [
          ...myDel.filter(qualifies).map(t => ({ kind: 'Delegation', due: t.due_date, desc: String(t.description || '').slice(0, 70) })),
          ...myChl.filter(qualifies).map(t => ({ kind: 'Checklist', due: t.due_date, desc: String(t.description || '').slice(0, 70) }))
        ];
        // Kyun chhoot gaye — sirf pending tasks ke liye (baki statuses ka reminder hota hi nahi)
        const skippedWhy = [];
        for (const t of [...myDel, ...myChl]) {
          if (t.status !== 'pending') continue;
          if (!t.due_date) skippedWhy.push('due date khali hai');
          else if (t.due_date > cutoff) skippedWhy.push(`due ${t.due_date} — abhi 2 din se door hai`);
        }
        if (!u.phone) reasons.push(`User "${u.name}" ka phone field khali hai`);
        if (!eligible.length) reasons.push(`User "${u.name}" ka koi bhi task reminder ke layak nahi (pending + due date agle 2 din me — ye chahiye)`);
        return {
          id: parseInt(u.id), name: u.name, role: u.role, phoneOnFile: u.phone || '(khali)',
          counts: {
            delegationPending: myDel.filter(t => t.status === 'pending').length,
            checklistPending: myChl.filter(t => t.status === 'pending').length,
            revised: [...myDel, ...myChl].filter(t => t.status === 'revised').length,
            report: myDel.filter(t => t.status === 'report').length
          },
          reminderEligibleTasks: eligible,
          skippedReasons: [...new Set(skippedWhy)]
        };
      });
    }

    // Aaj ke slots ka pass hua ya nahi
    const slotStatus = {};
    for (const s of waSlots()) {
      const key = `${s.h}:${String(s.m || 0).padStart(2, '0')}`;
      const mk = `wa_pass_${istDate}_${s.h}${String(s.m || 0).padStart(2, '0')}`;
      slotStatus[key] = (await _waSlotDone(mk)) ? 'aaj ka pass ho chuka' : 'abhi tak nahi chala';
    }

    res.json({
      phoneAsked: raw, phoneNormalized: want,
      nowIST: ist.toISOString().replace('T', ' ').slice(0, 16),
      isUser: matches.length > 0,
      user: userInfo,
      todaySlots: slotStatus,
      verdict: reasons.length ? reasons : ['Sab theek hai — is number par reminder jaana chahiye tha. Na gaya ho to server logs me "WhatsApp failed" dekho (API side ka issue).']
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send a one-off test WhatsApp: { phone, message }
app.post('/api/admin/test-whatsapp', requireAuth, requireAdmin, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const r = await sendWhatsApp(phone, message || 'Test message from Raabta Task Manager ✅');
  res.json(r);
});

// GET /api/admin/test-email — email setup sahi hai ya nahi, ek jagah jawab.
// Test mail HR_EMAIL par jaati hai (ya ?to=koi@email.com par). Fail ho to
// asli SMTP error yahin dikh jaata hai — server logs dhoondhne ki zaroorat nahi.
app.get('/api/admin/test-email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const to = String(req.query.to || process.env.HR_EMAIL || '').trim();
    const setup = {
      EMAIL_ENABLED: EMAIL_ENABLED ? 'true ✅' : 'false ❌ (isi wajah se koi mail nahi jaati)',
      SMTP_USER: process.env.SMTP_USER || 'NOT SET ❌',
      SMTP_PASS: process.env.SMTP_PASS
        ? `set ✅ (${String(process.env.SMTP_PASS).length} chars${String(process.env.SMTP_PASS).length === 16 ? '' : ' — Gmail App Password 16 ka hota hai, check karo'})`
        : 'NOT SET ❌',
      HR_EMAIL: process.env.HR_EMAIL || 'NOT SET ❌ (leave apply hone par mail kahin nahi jayegi)',
      APP_URL: process.env.APP_URL || 'NOT SET (mail me link nahi aayega)'
    };
    if (!to) return res.json({ setup, sent: false, error: 'HR_EMAIL set nahi hai — ya ?to=email daalo' });

    const r = await sendMail(to, 'Test — Raabta Task Manager email setup ✅', `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f6f9fc;padding:20px">
        <div style="background:#fff;border-radius:8px;padding:30px">
          <h2 style="color:#16a34a;margin-top:0">✅ Email setup kaam kar raha hai</h2>
          <p>Ye test mail Raabta Task Manager se bheji gayi hai.</p>
          <p style="color:#64748b;font-size:13px">Ab leave apply hone par HR ko, aur approve/reject par employee ko mail jayegi.</p>
          <p style="color:#64748b;font-size:13px">Task assign / daily reminder ki mail band hai — wo sirf WhatsApp par jaate hain.</p>
        </div>
      </div>`, 'test');

    res.json({
      setup, to,
      sent: !!(r && r.ok),
      result: r,
      verdict: (r && r.ok) ? `Mail bhej di — ${to} ka inbox check karo (spam bhi dekh lena)`
        : (r && r.skipped) ? `Nahi bheji: ${r.skipped}${r.hint ? ' — ' + r.hint : ''}`
        : `Fail: ${r && r.error}`
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/debug', async (req, res) => {
  try {
    const database = await getDB();
    const users = await database.findAll('Users');
    res.json({
      time: new Date().toISOString(),
      db: { connected: true, type: 'Google Sheets' },
      users: users.map(u => ({ id: u.id, name: u.name, role: u.role, department: u.department }))
    });
  } catch (e) {
    res.json({ time: new Date().toISOString(), db: { connected: false, error: e.message } });
  }
});

// ══════════════════════════════════════════════════════
// PAGES
// ══════════════════════════════════════════════════════
// no-cache: browser har baar server se poochhe "nayi file hai kya?" — isse
// deploy ke baad hard-refresh ki zaroorat nahi padti (bina iske log purani
// app.html dekhte rehte the aur naye features "show nahi ho rahe" lagte the)
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/app', (req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ══════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════
async function seedAdminIfNeeded() {
  const users = await db.findAll('Users');
  if (users.length === 0) {
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    await db.insert('Users', {
      name: 'Admin',
      email: 'admin@test.com',
      notification_email: '',
      password: 'admin123',
      role: 'admin',
      phone: '',
      department: '',
      week_off: '',
      extra_off: '',
      profile_image: '',
      created_at: nowStr
    });
    console.log('  Default admin user created: admin@test.com / admin123');
  }
}

(async () => {
  try {
    // Start background DB connection
    getDB()
      .then(() => runOneTimeMigrations())
      .then(() => setTimeout(() => backfillChecklistDoerName().catch(() => {}), 25 * 1000))
      // Khali label bharne ke BAAD purane/galat label taaza karo (30s par,
      // taaki backfill pehle nipat jaye). Sirf doer_name -- task kisi ka
      // nahi hilta.
      .then(() => setTimeout(() => resyncChecklistDoerLabels().catch(() => {}), 30 * 1000))
      .then(() => setTimeout(() => fixRaviKantLabelOnAshok().catch(() => {}), 33 * 1000))
      .then(() => setTimeout(() => restoreMumbaiSmLabels().catch(() => {}), 34 * 1000))
      .then(() => setTimeout(() => transferMumbaiSmToAkshatha().catch(() => {}), 40 * 1000))
      .then(() => setTimeout(() => seedHolidays2026().catch(() => {}), 36 * 1000))
      .then(() => setTimeout(() => repairNaNChecklistDates().catch(() => {}), 35 * 1000))
      .then(() => setTimeout(() => fixChecklistDateFormat().catch(() => {}), 45 * 1000))
      // Purana fix marker se bandha hai aur kuch rows chhod chuka hai --
      // ye har start par baaki ulti dates seedhi kar deta hai
      .then(() => setTimeout(() => straightenTaskDates().catch(() => {}), 50 * 1000))
      .then(() => setTimeout(() => removeOrphanOpenTasks().catch(() => {}), 55 * 1000))
      // Outbox aane se pehle jo assign-alert gum ho gaye — ek baar bhej do
      .then(() => setTimeout(() => backfillMissedAssignAlerts().catch(() => {}), 45 * 1000))
      .then(() => setTimeout(() => resetTimedOutOutbox().catch(() => {}), 55 * 1000))
      .then(() => setTimeout(() => refireTodays5pmReminder().catch(() => {}), 70 * 1000))
      // Sabse pehle chalao — drain ka pehla tick 60s baad aata hai, isliye ye
      // usse bahut pehle purana backlog saaf kar deta hai
      .then(() => setTimeout(() => clearOldOutboxBacklog().catch(() => {}), 5 * 1000))
      // Maintenance sheet ka data pehle se taiyar rakho — tab kholte hi
      // turant khule, "Loading" na dikhe
      .then(() => setTimeout(() => maintReadCredits(true).catch(() => {}), 25 * 1000))
      .then(() => setTimeout(() => backfillTodayMorningAssign().catch(() => {}), 15 * 1000))
      .then(() => setTimeout(() => resendTodays404Casualties().catch(() => {}), 10 * 1000))
      .then(() => setTimeout(() => cleanStrayManualMarkers().catch(() => {}), 8 * 1000))
      .then(() => setTimeout(() => refireMorning22Aug().catch(() => {}), 12 * 1000))
      .then(() => setTimeout(() => refirePM23Aug().catch(() => {}), 18 * 1000))
      .then(() => setTimeout(() => refireAM25Aug().catch(() => {}), 20 * 1000))
      .then(() => fixBeadRuleToYes().catch(() => {}))
      .then(() => setTimeout(() => resetFailedAfterApiSwitch().catch(() => {}), 80 * 1000))
      .catch(err => console.error('  Background DB connection failed (will retry on demand):', err.message));

    // SMTP verify (non-blocking)
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      mailTransporter.verify()
        .then(() => {
          console.log('  Gmail SMTP Ready');
          setTimeout(() => reminderScheduler(), 5000);
        })
        .catch(err => console.error('  SMTP verification failed:', err.message));
    } else {
      console.log('  SMTP credentials missing — emails disabled');
    }

    // WhatsApp reminders run independently of SMTP.
    setTimeout(() => whatsAppReminderScheduler(), 6000);

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n  Task Manager listening on port ${PORT}`);
      console.log(`  Login: admin@test.com / admin123\n`);
    });
  } catch (err) {
    console.error('  Startup error:', err.message);
    // Still start server so app is reachable; DB calls will retry on demand
    if (!app.listening) {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n  Task Manager (degraded) listening on port ${PORT}`);
        console.log('  Warning: DB connection failed — retrying on first request\n');
      });
    }
  }
})();
