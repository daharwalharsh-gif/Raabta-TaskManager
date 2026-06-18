// ====================================================================
// setup-new-sheet.js — Raabta Task Manager
// Creates ALL required tabs with correct headers in the NEW Google Sheet
// Sheet: https://docs.google.com/spreadsheets/d/1SlUOgq1QN70tbIdlNat_XEY4JYGHG3JQyyh3NBG_lYQ/
// ====================================================================
require('dotenv').config();
const { google } = require('googleapis');
const creds = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : require('./credentials.json');

const NEW_SHEET_ID = '1SlUOgq1QN70tbIdlNat_XEY4JYGHG3JQyyh3NBG_lYQ';

// All tabs required by the Raabta Task Manager backend
const TABS = [
  {
    name: 'Users',
    headers: [
      'id','name','email','notification_email','password',
      'role','phone','department','week_off','extra_off',
      'profile_image','created_at'
    ]
  },
  {
    name: 'Delegation_Tasks',
    headers: [
      'id','description','assigned_to','assigned_by','due_date',
      'status','priority','approval','waiting_approval','remarks',
      'frequency','last_reminder_date','created_at'
    ]
  },
  {
    name: 'Checklist_Tasks',
    headers: [
      'id','description','assigned_to','assigned_by','due_date',
      'status','priority','remarks','frequency','created_at'
    ]
  },
  {
    name: 'Task_Approvals',
    headers: [
      'id','task_id','task_type','requested_by','requested_to',
      'action_type','status','note','created_at'
    ]
  },
  {
    name: 'Task_Comments',
    headers: ['id','task_id','task_type','user_id','comment','created_at']
  },
  {
    name: 'Task_Transfers',
    headers: [
      'id','task_id','task_type','from_user','to_user',
      'requested_by','status','note','created_at'
    ]
  },
  {
    name: 'Week_Plans',
    headers: [
      'id','employee_id','hod_id','start_date',
      'target_count','improvement_pct','created_at','updated_at'
    ]
  },
  {
    name: 'MIS_Report',
    headers: [
      'period','employee_id','employee_name','department',
      'delegation_total','delegation_done','delegation_pending',
      'checklist_total','checklist_done','checklist_pending'
    ]
  },
  {
    name: 'FMS_Config',
    headers: [
      'id','name','sheet_id','sheet_name','steps','created_at','updated_at'
    ]
  },
  {
    name: 'Holidays',
    headers: ['id','date','name','created_at']
  }
];

(async () => {
  console.log('\n🚀 Raabta Task Manager — New Sheet Setup');
  console.log('📋 Sheet ID:', NEW_SHEET_ID);
  console.log('─'.repeat(55));

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Get existing tabs
  const meta = await sheets.spreadsheets.get({ spreadsheetId: NEW_SHEET_ID });
  const existing = meta.data.sheets.map(s => s.properties.title);
  console.log('\n📌 Existing tabs:', existing.length ? existing.join(', ') : '(none)');

  // Determine which tabs need to be created
  const toCreate = TABS.filter(t => !existing.includes(t.name));
  const alreadyExist = TABS.filter(t => existing.includes(t.name));

  if (alreadyExist.length) {
    console.log('✅ Already exist:', alreadyExist.map(t => t.name).join(', '));
  }

  // Create missing tabs
  if (toCreate.length > 0) {
    console.log('\n📝 Creating tabs:', toCreate.map(t => t.name).join(', '));
    const requests = toCreate.map(tab => ({
      addSheet: { properties: { title: tab.name } }
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: NEW_SHEET_ID,
      requestBody: { requests }
    });
    console.log('✅ Tabs created!');
  } else {
    console.log('\nℹ️  All tabs already exist — skipping creation');
  }

  // Write headers to ALL tabs (safe — won't overwrite row 1 data below)
  console.log('\n📝 Writing headers to all tabs...');
  const headerData = TABS.map(tab => ({
    range: `${tab.name}!A1:${String.fromCharCode(64 + tab.headers.length)}1`,
    values: [tab.headers]
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: NEW_SHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: headerData }
  });
  console.log('✅ Headers written!');

  // Summary
  console.log('\n' + '═'.repeat(55));
  console.log('🎉 NEW SHEET READY — Raabta Task Manager');
  console.log('─'.repeat(55));
  TABS.forEach(t => {
    console.log(`  📄 ${t.name.padEnd(20)} → ${t.headers.length} columns`);
  });
  console.log('\n🔗 Sheet URL:');
  console.log(`   https://docs.google.com/spreadsheets/d/${NEW_SHEET_ID}/edit`);
  console.log('\n✅ Update your .env: SHEET_ID=' + NEW_SHEET_ID);
  console.log('✅ Restart server: npm start');
  console.log('─'.repeat(55) + '\n');
})().catch(e => {
  console.error('\n❌ Error:', e.message);
  if (e.message.includes('403') || e.message.includes('PERMISSION_DENIED')) {
    console.error('💡 Make sure the Google Service Account has Editor access to this sheet!');
    console.error('   Share the sheet with your service account email from credentials.json');
  }
  process.exit(1);
});
