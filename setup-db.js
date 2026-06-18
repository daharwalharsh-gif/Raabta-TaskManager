// One-time local setup: creates the task_manager DB, all tables, and an admin user.
// Usage:  DB_PASSWORD="yourpass" node setup-db.js
// Reads DB host/user/password from env (same vars as the app / .env).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const ADMIN = {
  name: 'Admin',
  email: 'admin@test.com',
  password: 'admin123',          // <-- login password (plain); stored as bcrypt hash
  role: 'admin',
};

(async () => {
  const cfg = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  };

  console.log('→ Connecting to MySQL at', cfg.host, 'as', cfg.user, '...');
  let conn;
  try {
    conn = await mysql.createConnection(cfg);
  } catch (e) {
    console.error('✗ Could not connect to MySQL:', e.message);
    console.error('  Make sure the MySQL service is running and DB_PASSWORD is correct.');
    process.exit(1);
  }

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('→ Creating database + tables from schema.sql ...');
  await conn.query(schema);
  await conn.query('USE task_manager');

  // Seed admin (only if email not already present)
  const [rows] = await conn.query('SELECT id FROM users WHERE email=? LIMIT 1', [ADMIN.email]);
  if (rows.length) {
    console.log('→ Admin user already exists:', ADMIN.email);
  } else {
    const hash = bcrypt.hashSync(ADMIN.password, 10);
    await conn.query(
      'INSERT INTO users (name,email,notification_email,password,role,phone,department,week_off,extra_off) VALUES (?,?,?,?,?,?,?,?,?)',
      [ADMIN.name, ADMIN.email, '', hash, ADMIN.role, null, '', '', '']
    );
    console.log('✓ Admin user created.');
  }

  await conn.end();
  console.log('\n✅ Setup complete!');
  console.log('   Login →  email: ' + ADMIN.email + '   password: ' + ADMIN.password);
})().catch(e => { console.error('✗ Setup failed:', e); process.exit(1); });
