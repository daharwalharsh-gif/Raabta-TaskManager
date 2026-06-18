require('dotenv').config();
const { google } = require('googleapis');
const creds = require('./credentials.json');

const SHEET_ID = '15YPWDhShll1BBE8r-e91o4S7kB-i3BnXq5qeY7dHlZw';

const TABS = [
  { name: 'Users',            headers: ['id','name','email','notification_email','password','role','phone','department','week_off','extra_off','profile_image','created_at'] },
  { name: 'Delegation_Tasks', headers: ['id','description','assigned_to','assigned_by','due_date','status','priority','approval','waiting_approval','remarks','frequency','last_reminder_date','created_at'] },
  { name: 'Checklist_Tasks',  headers: ['id','description','assigned_to','assigned_by','due_date','status','priority','remarks','frequency','created_at'] },
  { name: 'Task_Approvals',   headers: ['id','task_id','task_type','requested_by','requested_to','action_type','status','note','created_at'] },
  { name: 'Task_Comments',    headers: ['id','task_id','task_type','user_id','comment','created_at'] },
  { name: 'Task_Transfers',   headers: ['id','task_id','task_type','from_user','to_user','requested_by','status','note','created_at'] },
  { name: 'Week_Plans',       headers: ['id','employee_id','hod_id','start_date','target_count','improvement_pct','created_at','updated_at'] },
];

(async () => {
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });

  // Get existing sheets
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);
  console.log('Existing tabs:', existing.join(', '));

  const requests = [];

  for (const tab of TABS) {
    if (!existing.includes(tab.name)) {
      requests.push({ addSheet: { properties: { title: tab.name } } });
      console.log('Will create tab:', tab.name);
    } else {
      console.log('Tab already exists:', tab.name);
    }
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    console.log('✅ Tabs created');
  }

  // Add headers to each tab
  const data = TABS.map(tab => ({
    range: `${tab.name}!A1:${String.fromCharCode(64 + tab.headers.length)}1`,
    values: [tab.headers],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data },
  });

  console.log('✅ Headers written to all tabs');
  console.log('\nSheet tabs ready:');
  TABS.forEach(t => console.log(' •', t.name, '→', t.headers.join(', ')));
})().catch(e => console.error('❌', e.message));
