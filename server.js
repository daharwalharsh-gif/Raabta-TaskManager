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
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════
// GOOGLE SHEETS DB LAYER
// ══════════════════════════════════════════════════════
// Retry wrapper for Google Sheets API calls (handles quota exceeded)
async function withRetry(fn, maxRetries = 2) {
  let delay = 500;
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
        delay *= 2;
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
}

// ── Sheets client (singleton) ──
let _sheetsClient = null;
async function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const creds = process.env.GOOGLE_CREDENTIALS
    ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
    : require('./credentials.json');
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const client = await auth.getClient();
  _sheetsClient = google.sheets({ version: 'v4', auth: client });
  return _sheetsClient;
}

// Global db instance
let db = null;
let dbInitializationPromise = null;

async function initializeDatabase() {
  const sheetsApi = await getSheetsClient();
  // Verify connection by reading spreadsheet metadata
  await withRetry(() => sheetsApi.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'spreadsheetId' }));
  db = new SheetDB(sheetsApi, SHEET_ID);
  console.log('  Google Sheets DB connected (with 45s in-memory cache)');
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
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendMail(to, subject, html) {
  if (!to || !process.env.SMTP_USER) return;
  try {
    await mailTransporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME || 'Task Manager'}" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
    console.log(`  Email sent to ${to} — ${subject}`);
  } catch (err) {
    console.error(`  Email failed (${to}):`, err.message);
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
      extra_off: user.extra_off || ''
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

    const todayStr = new Date().toISOString().split('T')[0];

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
        else if (t.status === 'completed') completed++;
        // Dashboard table: only show tasks due today or overdue (not future)
        if (t.status === 'pending' && (!t.due_date || t.due_date <= todayStr)) {
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
        else if (t.status === 'completed') completed++;
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

app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { type, desc, assignedTo, approverEmail, date, priority, approval, remarks } = req.body;
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
      await db.insert('Delegation_Tasks', {
        description: desc, assigned_to: targetUser, assigned_by: assignedBy,
        due_date: date, status: 'pending', priority: priority || 'low',
        approval: approval || 'no', waiting_approval: '0', remarks: remarks || '',
        frequency: '', last_reminder_date: '', created_at: nowStr
      });
      // Non-blocking email
      (async () => {
        const target = await getNotifyTarget(parseInt(targetUser));
        if (!target) return;
        const assigner = await db.findOne('Users', { id: assignedBy });
        await sendMail(
          target.email,
          `New Task Assigned: ${(desc || '').slice(0, 60)}`,
          delegationEmailHtml({
            assigneeName: target.name,
            assignerName: assigner?.name || 'Admin',
            desc, dueDate: date,
            priority: priority || 'low',
            approval: approval || 'no',
            remarks: remarks || ''
          })
        );
      })();
    } else {
      await db.insert('Checklist_Tasks', {
        description: desc, assigned_to: targetUser, assigned_by: String(req.session.userId),
        due_date: date, status: 'pending', priority: priority || 'low',
        remarks: remarks || '', frequency: '', created_at: nowStr
      });
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

    if (status === 'completed' && waitingApproval) {
      // Cancel pending approvals
      const pendingApprovals = await db.findWhere('Task_Approvals', { task_id: req.params.id, task_type: type, status: 'pending' });
      for (const a of pendingApprovals) await deleteRow('Task_Approvals', a.id);
      const upd = { status: 'completed' };
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

    const upd = { status };
    if (type === 'delegation') upd.waiting_approval = '0';
    if (newDate && status === 'revised') upd.due_date = newDate;
    await db.update(tabName, req.params.id, upd);
    res.json({ success: true, needsApproval: false });
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
    let deleted = 0;
    for (const t of tasks) { await deleteRow('Checklist_Tasks', t.id); deleted++; }
    res.json({ success: true, deleted });
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
    let deleted = 0;
    for (const t of tasks) { await deleteRow('Checklist_Tasks', t.id); deleted++; }
    res.json({ success: true, deleted });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      await db.update(tabName, appr.task_id, { status: appr.action_type, waiting_approval: '0' });
    } else {
      await db.update(tabName, appr.task_id, { waiting_approval: '0' });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════
// MIS
// ══════════════════════════════════════════════════════
app.get('/api/mis', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
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
      return total > 0 ? Math.max(-100, Math.round((0 - (pending / total) * 100 - (overdue / total) * 50 - (revised / total) * 25) * 10) / 10) : 0;
    };

    const aggregateTasks = (tasks, type) => {
      const result = {};
      for (const t of tasks) {
        if (!t.due_date || t.due_date < start || t.due_date > end) continue;
        const u = userMap[String(t.assigned_to)];
        if (!u) continue;
        if (isHod && u.department !== hodDept) continue;
        const uid = String(t.assigned_to);
        if (!result[uid]) result[uid] = { userId: parseInt(uid), name: u.name, total: 0, pending: 0, completed: 0, revised: 0, overdue: 0 };
        result[uid].total++;
        if (t.status === 'pending') { result[uid].pending++; if (t.due_date < todayStr) result[uid].overdue++; }
        if (t.status === 'completed') result[uid].completed++;
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

app.get('/api/mis/detail', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
    const { userId, type, start, end } = req.query;
    if (!userId || !start || !end) return res.status(400).json({ error: 'Missing params' });
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

app.get('/api/mis/all', requireAuth, requireAdminOrHod, async (req, res) => {
  try {
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
      if (!userStats[uid]) {
        userStats[uid] = {
          userId: parseInt(uid), name: u.name, department: u.department || '',
          delegation: calc(0, 0, 0, 0),
          checklist: calc(0, 0, 0, 0)
        };
      }
      return userStats[uid];
    };

    const delTasks = await db.findAll('Delegation_Tasks');
    for (const t of delTasks) {
      if (!t.due_date || t.due_date < start || t.due_date > end) continue;
      const e = ensure(t.assigned_to);
      if (!e) continue;
      const d = e.delegation;
      d.total++;
      if (t.status === 'pending') { d.pending++; if (t.due_date < todayStr) d.overdue++; }
      if (t.status === 'completed') d.completed++;
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
      if (t.status === 'completed') c.completed++;
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

    // Pre-compute previous steps' actualCol indices
    const prevStepActualIdxs = fms.steps.slice(0, stepIdx)
      .map(s => colLetterToIdx(s.actualCol || ''))
      .filter(i => i >= 0);

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

    // Filter: real data row + ALL previous steps done + current step pending
    const pending = rawDataRows
      .map((row, idx) => ({ row, sheetRow: headerRow + idx + 1 }))
      .filter(({ row }) => {
        if (!hasRealData(row)) return false;
        // All previous steps must be done
        for (const prevIdx of prevStepActualIdxs) {
          if (!isDone(row[prevIdx])) return false;
        }
        // Current step must be pending
        if (actualIdx < 0) return true;
        return !isDone(row[actualIdx]);
      });

    // Apply showCols filter to determine which columns to show in table
    const showColsIdx = (step.showCols || []).map(Number).filter(n => !isNaN(n));
    const visibleHeaders = showColsIdx.length > 0
      ? headers.filter((h, i) => showColsIdx.includes(i))
      : headers.filter((h, i) => i !== actualIdx); // hide actual col by default

    // Build response in format frontend expects: {sheetRowNumber, planValue, data:{...}}
    const rows = pending.map(({ row, sheetRow }) => {
      const data = {};
      visibleHeaders.forEach((h, vi) => {
        const colIdx = showColsIdx.length > 0 ? showColsIdx[vi] : headers.indexOf(h);
        data[h || `Col_${idxToColLetter(colIdx)}`] = row[colIdx] !== undefined ? String(row[colIdx]) : '';
      });
      return {
        sheetRowNumber: sheetRow,
        planValue: planIdx >= 0 ? (row[planIdx] || '') : '',
        data
      };
    });

    res.json({ rows, headers: visibleHeaders, total: rows.length, allHeaders: headers });
  } catch(err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — FMS sheet ko service account ke saath share karo';
    if (msg.includes('404')) msg = 'Sheet not found — FMS config mein Sheet ID/Tab check karo';
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
    if (extraFields && Array.isArray(extraFields)) {
      for (const ef of extraFields) {
        if (ef.col && ef.value !== undefined) {
          updates.push({ range: `${fms.sheet_name}!${ef.col.toUpperCase()}${rowIndex}`, values: [[ef.value]] });
        }
      }
    }

    if (updates.length > 0) {
      await withRetry(() => d.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'USER_ENTERED', data: updates }
      }));
    }

    res.json({ success: true });
  } catch(err) {
    let msg = err.message || 'Unknown error';
    if (msg.includes('403')) msg = 'Access denied — sheet ko service account ke saath Editor access de';
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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

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
    getDB().catch(err => console.error('  Background DB connection failed (will retry on demand):', err.message));

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

    app.listen(PORT, () => {
      console.log(`\n  Task Manager: http://localhost:${PORT}`);
      console.log(`  Login: admin@test.com / admin123\n`);
    });
  } catch (err) {
    console.error('  Startup error:', err.message);
    // Still start server so app is reachable; DB calls will retry on demand
    if (!app.listening) {
      app.listen(PORT, () => {
        console.log(`\n  Task Manager (degraded): http://localhost:${PORT}`);
        console.log('  Warning: Google Sheets connection failed — retrying on first request\n');
      });
    }
  }
})();
