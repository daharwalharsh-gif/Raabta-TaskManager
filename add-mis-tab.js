require('dotenv').config();
const { google } = require('googleapis');
const creds = require('./credentials.json');
const SHEET_ID = '15YPWDhShll1BBE8r-e91o4S7kB-i3BnXq5qeY7dHlZw';

(async () => {
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);

  if (!existing.includes('MIS_Report')) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'MIS_Report' } } }] }
    });
    // Add headers
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'MIS_Report!A1:J1',
      valueInputOption: 'RAW',
      requestBody: { values: [['period','employee_id','employee_name','department','delegation_total','delegation_done','delegation_pending','checklist_total','checklist_done','checklist_pending']] }
    });
    console.log('✅ MIS_Report tab created with headers');
  } else {
    console.log('ℹ️  MIS_Report tab already exists');
  }
})().catch(e => console.error('❌', e.message));
