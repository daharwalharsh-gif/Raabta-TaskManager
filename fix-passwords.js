// Fix existing bcrypt hashed passwords in Google Sheet → replace with plain text
require('dotenv').config();
const { google } = require('googleapis');
const creds = require('./credentials.json');
const SHEET_ID = '15YPWDhShll1BBE8r-e91o4S7kB-i3BnXq5qeY7dHlZw';

(async () => {
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:L' });
  const rows = res.data.values || [];
  if (rows.length <= 1) { console.log('No users found'); return; }

  const headers = rows[0];
  const passwordCol = headers.indexOf('password');
  const emailCol = headers.indexOf('email');

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const pwd = row[passwordCol] || '';
    if (pwd.startsWith('$2a$') || pwd.startsWith('$2b$')) {
      // Replace with default plain text: use 'admin123' for admin, else 'shakti123'
      const email = row[emailCol] || '';
      const newPwd = email.includes('admin') ? 'admin123' : 'shakti123';
      const colLetter = String.fromCharCode(65 + passwordCol);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Users!${colLetter}${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[newPwd]] }
      });
      console.log(`✅ Fixed: ${email} → password set to: ${newPwd}`);
    }
  }
  console.log('Done!');
})().catch(e => console.error('❌', e.message));
