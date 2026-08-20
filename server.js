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
    this.TTL = 2000;        // short cache to coalesce repeat reads within a request
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
    was_reported: "VARCHAR(5) DEFAULT '0'"
  },
  Checklist_Tasks: {
    description: "TEXT", assigned_to: "VARCHAR(20) DEFAULT ''", assigned_by: "VARCHAR(20) DEFAULT ''",
    due_date: "VARCHAR(40) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    priority: "VARCHAR(20) DEFAULT 'low'", remarks: "TEXT", frequency: "VARCHAR(20) DEFAULT ''",
    created_at: "VARCHAR(40) DEFAULT ''"
  },
  Task_Approvals: {
    task_id: "VARCHAR(20) DEFAULT ''", task_type: "VARCHAR(20) DEFAULT ''",
    requested_by: "VARCHAR(20) DEFAULT ''", requested_to: "VARCHAR(20) DEFAULT ''",
    action_type: "VARCHAR(20) DEFAULT ''", status: "VARCHAR(20) DEFAULT 'pending'",
    note: "TEXT", created_at: "VARCHAR(40) DEFAULT ''"
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
  App_State: {
    key_name: "VARCHAR(120) DEFAULT ''", value: "TEXT", updated_at: "VARCHAR(40) DEFAULT ''"
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

// Status object wapas karta hai (diagnose ke liye) — throw kabhi nahi karta,
// taaki koi bhi mail fail ho to app ka flow na ruke.
async function sendMail(to, subject, html) {
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
        await sendMail(email, subject, reminderEmailHtml(byUser, todayStr));
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
const WA_OUTBOX_SEND_TIMEOUT = 90000; // Aumpfy healthy ho to ~50s me jawab de deta hai
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
  const patch = ok
    ? { status: 'sent', sent_at: new Date().toISOString().replace('T', ' ').split('.')[0] }
    : { status: 'pending', attempts: isUpstreamDown(err) ? '0' : '1', last_error: err };
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
      // 'failed' = koshish poori karke haar maani. 'unknown' = MAX_POSTS baar
      // POST kiya par Aumpfy ne kabhi jawab hi nahi diya — dono ko phir mauka
      // do, warna 'unknown' hamesha ke liye orphan reh jaata (Harsh ka niyam:
      // message kabhi hamesha ke liye ruka na rahe).
      if (r.status !== 'failed' && r.status !== 'unknown') continue;
      if (String(r.created_at || '') < dayAgo) continue;
      const n = parseInt(r.revivals) || 0;
      if (n >= WA_OUTBOX_MAX_REVIVALS) continue;
      await d.update('WA_Outbox', r.id, {
        status: 'pending', attempts: String(WA_OUTBOX_MAX_ATTEMPTS - 1), posts: '0', revivals: String(n + 1)
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
    for (let i = 0; i < ready.length; i += WA_OUTBOX_CONCURRENCY) {
      await Promise.all(ready.slice(i, i + WA_OUTBOX_CONCURRENCY).map(async row => {
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
          // Aumpfy ki kharabi ho to koshish wapas — message ki budget nahi katti
          const down = isUpstreamDown(err);
          const keptAttempts = down ? String(attempts - 1) : String(attempts);
          const giveUp = !down && attempts >= WA_OUTBOX_MAX_ATTEMPTS;
          try {
            await d.update('WA_Outbox', row.id, {
              status: giveUp ? 'failed' : 'pending',
              attempts: keptAttempts, last_error: String(err)
            });
          } catch (e) {
            console.error('  WA outbox — status likhna fail:', e.message);
          }
          console.error(`  WA outbox ${giveUp ? 'GAVE UP' : (down ? 'aumpfy-down, koshish nahi gini' : 'retry')} (${keptAttempts}/${WA_OUTBOX_MAX_ATTEMPTS}) — ${row.person || row.phone}: ${err}`);
        }
      }));
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
    const marker = `wa_pass_${dateStr}_${slotKey || istHour}`;
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

    const isPending = t => t.status === 'pending' && t.due_date && t.due_date <= cutoff;
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
    for (const uid of Object.keys(byUser)) {
      const user = userMap[uid];
      const phone = user && user.phone ? normalizePhone(user.phone) : '';
      if (!phone) { noPhone++; continue; }
      const tasks = byUser[uid].sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
      recipients.push({ phone, name: user.name, tasks });
    }

    // Reminder ab OUTBOX se jaate hain — pehle DB me likhe jaate hain, phir
    // drain unhe EK-EK karke bhejta hai. Pehle 8 ek saath jaate the aur Aumpfy
    // un sabko timeout kar deta tha; marker "bhej diya" bol deta tha aur
    // message hamesha ke liye gum ho jaate the. Ab fail ho to retry hota hai.
    let queued = 0;
    for (const r of recipients) {
      const row = await queueWhatsApp(
        r.phone, waReminderMsg(r.name, r.tasks, todayStr),
        'daily-reminder', marker, r.name, { immediate: false }
      );
      if (row) queued++;
    }
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

// Har request par slot check — par minute me ek baar se zyada nahi.
let _waLastCheck = 0;
function waRequestHook(req, res, next) {
  const now = Date.now();
  if (now - _waLastCheck > 60000) {
    _waLastCheck = now;
    checkAndFireDueSlots().catch(e => console.error('  WA request-hook error:', e.message));
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
function selfKeepAlive() {
  // Sirf live server par — local machine par chala to test karte waqt asli
  // reminders chale jaate
  if ((process.env.NODE_ENV || '').toLowerCase() !== 'production') {
    console.log('  Self keep-alive OFF (NODE_ENV production nahi hai)');
    return;
  }
  const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '').replace(/\/app$/, '');
  if (!base) {
    console.log('  Self keep-alive OFF — .env me APP_URL set karo (warna app so jayegi aur slot miss hoga)');
    return;
  }
  const url = `${base}/api/cron/wa-reminders`;
  _keepAliveUrl = url;
  const EVERY_MIN = 4;   // Hostinger ~5+ min idle par sulata hai, usse pehle jagao

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
      hrReport: isHrReportUser(user.role, user.email, user.notification_email)
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
        if (t.status === 'pending') pending++;
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
        if (t.status === 'pending') pending++;
        else if (t.status === 'revised') revised++;
        else if (t.status === 'completed' || t.status === 'closed') completed++;
        // Dashboard table: only show tasks due today or overdue (not future)
        if (t.status === 'pending' && (!t.due_date || t.due_date <= todayStr)) {
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
      pending, revised, completed,
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

    const allTasks = await db.findAll(tabName);

    const tasks = allTasks.filter(t => {
      if (isMine) {
        return String(t.assigned_by) === String(uid);
      }
      // Approval-pending naya task: doer ko tabhi dikhe jab approve ho jaye
      if (t.status === 'waiting_approval' && !isAdmin && role !== 'pc') return false;
      if (allowedUserIds && !allowedUserIds.includes(String(t.assigned_to))) return false;
      if (!isDeleg && !includeFuture && t.due_date > todayStr) return false;
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

// CRM data — SABHI doers ke pending/revised tasks (delegation + checklist).
// Sirf admin ya pc@raabtajewels.com ke liye (CRM tab wahi dekhte hain) —
// pc account ka role 'user' ho tab bhi yahan sabka data milta hai.
app.get('/api/crm/tasks', requireAuth, async (req, res) => {
  try {
    let allowed = req.session.role === 'admin';
    if (!allowed) {
      const me = await db.findOne('Users', { id: String(req.session.userId) });
      allowed = ((me?.email || '').trim().toLowerCase() === 'pc@raabtajewels.com');
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
    const { type, desc, assignedTo, approverEmail, approverId, date, priority, approval, remarks } = req.body;
    if (!desc || !date) return res.status(400).json({ error: 'Description and date required' });
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
        // Email — in parallel
        getNotifyTarget(parseInt(targetUser)).then(target => {
          if (!target) return;
          return sendMail(
            target.email,
            `New Task Assigned: ${(desc || '').slice(0, 60)}`,
            delegationEmailHtml({
              assigneeName: target.name, assignerName,
              desc, dueDate: date,
              priority: priority || 'low', approval: approval || 'no', remarks: remarks || ''
            })
          );
        }).catch(e => console.error('  Email notify error:', e.message));
      })();
    } else {
      await db.insert('Checklist_Tasks', {
        description: desc, assigned_to: targetUser, assigned_by: String(req.session.userId),
        due_date: date, status: 'pending', priority: priority || 'low',
        remarks: remarks || '', frequency: '', created_at: nowStr
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

app.post('/api/tasks/bulk-checklist', requireAuth, requireAdmin, async (req, res) => {
  try {
    const db = await getDB();
    const { desc, assignedTo, priority, remarks, dates, frequency } = req.body;
    if (!desc || !assignedTo || !dates || !dates.length) return res.status(400).json({ error: 'Missing fields' });
    const freq = (frequency || '').toLowerCase().trim();
    const nowStr = new Date().toISOString().replace('T', ' ').split('.')[0];
    const rows = dates.map(date => ({
      description: desc, assigned_to: String(parseInt(assignedTo)),
      assigned_by: String(req.session.userId), due_date: date,
      status: 'pending', priority: priority || 'low',
      remarks: remarks || '', frequency: freq, created_at: nowStr
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
      await db.update(tabName, req.params.id, { status: 'report', waiting_approval: '0', was_reported: '1', ...attUpd });
      return res.json({ success: true });
    }

    if (status === 'completed' && waitingApproval) {
      // Cancel pending approvals
      const pendingApprovals = await db.findWhere('Task_Approvals', { task_id: req.params.id, task_type: type, status: 'pending' });
      for (const a of pendingApprovals) await deleteRow('Task_Approvals', a.id);
      const upd = { status: 'completed', ...attUpd };
      if (type === 'delegation') upd.waiting_approval = '0';
      await db.update(tabName, req.params.id, upd);
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

    const upd = { status, ...attUpd };
    if (type === 'delegation') upd.waiting_approval = '0';
    if (newDate && status === 'revised') upd.due_date = newDate;
    await db.update(tabName, req.params.id, upd);
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

app.put('/api/tasks/:id/edit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { type, desc, date, priority, approval, remarks } = req.body;
    const tabName = getTabName(type || 'delegation');
    const upd = { description: desc, due_date: date, remarks: remarks || '' };
    if (type === 'delegation') { upd.priority = priority || 'low'; upd.approval = approval || 'no'; }
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

// ══════════════════════════════════════════════════════
// ONE-TIME MIGRATIONS — startup par chalti hain, App_State marker se sirf
// EK BAAR. Dobara deploy/restart hone par apne aap skip ho jaati hain.
// ══════════════════════════════════════════════════════
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
      const upd = { status: appr.action_type, waiting_approval: '0' };
      if (appr.action_type === 'report') upd.was_reported = '1';
      await db.update(tabName, appr.task_id, upd);
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
      for (const to of targets) await sendMail(to, subject, html);
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
          const r = await sendMail(to, subject, html);
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
    const isHod = req.session.role === 'hod';
    // Doer (normal user) ko sirf apni report dikhti hai
    const selfOnly = !['admin', 'hod', 'pc'].includes(req.session.role) ? String(req.session.userId) : null;
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
    if (!['admin', 'hod', 'pc'].includes(req.session.role) && String(userId) !== String(req.session.userId)) {
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
    const isHod = req.session.role === 'hod';
    // Doer (normal user) ko sirf apni row dikhti hai
    const selfOnly = !['admin', 'hod', 'pc'].includes(req.session.role) ? String(req.session.userId) : null;
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

app.get('/api/mis/fms', requireAuth, requireAdminOrHod, async (req, res) => {
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
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const all = await db.findAll('Users');
    const result = all.filter(u => u && u.id && u.name).map(u => ({
      id: parseInt(u.id), name: u.name, email: u.email,
      notification_email: u.notification_email || '',
      role: u.role, phone: u.phone || '',
      department: u.department || '', week_off: u.week_off || '',
      extra_off: u.extra_off || ''
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
    await db.update('Users', req.params.id, upd);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
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

// GET /api/fms-tasks/:fmsId/steps/:stepId/rows — fetch pending rows from external sheet
app.get('/api/fms-tasks/:fmsId/steps/:stepId/rows', requireAuth, async (req, res) => {
  try {
    const d = await getDB();
    const fmsRow = await d.findOne('FMS_Config', { id: String(req.params.fmsId) });
    if (!fmsRow) return res.status(404).json({ error: 'FMS not found' });

    const fms = parseFMSRow(fmsRow);
    // Find current step index (0-based)
    const stepIdx = fms.steps.findIndex((s,i) => String(s.id || i+1) === String(req.params.stepId));
    if (stepIdx < 0) return res.json({ rows: [], headers: [], total: 0, allHeaders: [] });
    const step = fms.steps[stepIdx];

    const spreadsheetId = extractSheetId(fms.sheet_id);
    const headerRow = parseInt(fms.header_row) || 1;

    // Fetch full sheet — use wide range to cover columns beyond Z
    const response = await withRetry(() => d.sheets.spreadsheets.values.get({
      spreadsheetId, range: `${fms.sheet_name}!A1:ZZ`
    }));
    const allRows = response.data.values || [];
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
    const isRelevant = (row, s) => {
      const pIdx = colLetterToIdx(s.planCol || '');
      return pIdx < 0 || (row[pIdx] || '').trim() !== '';
    };
    const pending = rawDataRows
      .map((row, idx) => ({ row, sheetRow: headerRow + idx + 1 }))
      .filter(({ row }) => {
        if (!hasRealData(row)) return false;
        // Ye row is step par apply hi nahi hoti to yahan pending nahi dikhegi
        if (!isRelevant(row, step)) return false;
        // Sirf un previous steps ko "done hona chahiye" treat karo jo IS ROW par
        // relevant hain — jo step row par lagu hi nahi, wo block nahi karega
        for (let i = 0; i < stepIdx; i++) {
          const prevStep = fms.steps[i];
          if (!isRelevant(row, prevStep)) continue;
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
    const rows = pending.map(({ row, sheetRow }) => {
      const data = {};
      cols.forEach(c => { data[c.key] = row[c.idx] !== undefined ? String(row[c.idx]) : ''; });
      return {
        sheetRowNumber: sheetRow,
        planValue: planIdx >= 0 ? (row[planIdx] || '') : '',
        data
      };
    });

    res.json({ rows, headers: cols.map(c => c.key), total: rows.length, allHeaders: headers });
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
        const resp = await withRetry(() => d.sheets.spreadsheets.values.get({
          spreadsheetId: extractSheetId(fms.sheet_id), range: `${fms.sheet_name}!A1:ZZ`
        }));
        allRows = resp.data.values || [];
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
    }
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
    const isRelevant = (row, s) => {
      const p = colLetterToIdx(s.planCol || '');
      return p < 0 || String(row[p] || '').trim() !== '';
    };
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
        const rel = isRelevant(row, s);
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
        complete: applicable > 0 && doneCount === applicable
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

    const spreadsheetId = extractSheetId(fms.sheet_id);
    const updates = [];

    if (step.actualCol && actualValue !== undefined) {
      updates.push({ range: `${fms.sheet_name}!${step.actualCol.toUpperCase()}${rowIndex}`, values: [[actualValue]] });
    }
    if (step.delayReasonCol && delayReason !== undefined) {
      updates.push({ range: `${fms.sheet_name}!${step.delayReasonCol.toUpperCase()}${rowIndex}`, values: [[delayReason]] });
    }
    if (step.doerNameCol && doerName !== undefined) {
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
        if (val !== undefined) {
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

    res.json({ success: true, generatedIds });
  } catch(err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — sheet ko service account ke saath Editor access de';
    res.status(500).json({ error: msg });
  }
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
      await db.update(tabName, tr.task_id, { assigned_to: String(tr.to_user) });
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
app.get('/api/cron/wa-reminders', async (req, res) => {
  try {
    if (!WA.enabled || !WA.url || !WA.apiKey) return res.json({ skipped: 'not-configured' });
    const ist = new Date(Date.now() + 330 * 60000);
    const istTime = ist.toISOString().replace('T', ' ').slice(0, 16) + ' IST';
    if (ist.getUTCDay() === 1) return res.json({ skipped: 'monday', now: istTime });
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
      outbox = { sent: 0, pending: 0, failed: 0, sending: 0, unknown: 0 };
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
        ? `ON — har 4 min self-ping (${_keepAliveUrl})`
        : ((process.env.NODE_ENV || '').toLowerCase() !== 'production'
            ? 'OFF — NODE_ENV production nahi hai'
            : 'OFF — .env me APP_URL set karo, phir restart'),
      keptAlive: true
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
    if (ist.getUTCDay() === 1) reasons.push('Aaj Monday hai — Monday ko reminders skip hote hain');
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
        </div>
      </div>`);

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
      // Outbox aane se pehle jo assign-alert gum ho gaye — ek baar bhej do
      .then(() => setTimeout(() => backfillMissedAssignAlerts().catch(() => {}), 45 * 1000))
      .then(() => setTimeout(() => resetTimedOutOutbox().catch(() => {}), 55 * 1000))
      .then(() => setTimeout(() => refireTodays5pmReminder().catch(() => {}), 70 * 1000))
      // Sabse pehle chalao — drain ka pehla tick 60s baad aata hai, isliye ye
      // usse bahut pehle purana backlog saaf kar deta hai
      .then(() => setTimeout(() => clearOldOutboxBacklog().catch(() => {}), 5 * 1000))
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
