# Sohan Healthcare - Task Manager (v20)

## 🆕 What's New in v20 — Employee Records (Plan vs Done)

1. **Naya "Records" tab** — Admin, HOD **aur** PC teeno ko dikhta hai (sidebar me 📒 Records).
   Yahan har employee ka ek hi jagah pura record dikhta hai: uska **committed plan**
   (set kiya hua weekly improvement goal) us employee ke saamne hi inline, aur uske
   saath **commit vs complete** ka pura hisaab.

2. **Set Plan ab alag nahi — har employee ke saamne** — Pehle "Set Plan" ek alag button/
   modal tha. Ab Records tab me har employee ki row me hi 📅 **Set Plan** button hai;
   uska committed plan usi row me dikhta hai aur save karte hi turant update ho jaata hai.

3. **Scoring + Total ab Admin/HOD/PC sabko EK JAISA** — Pehle ek hi employee ka MIS score
   aur total task count Admin ko alag aur HOD ko alag dikh sakta tha (FMS credit role ke
   hisaab se filter ho raha tha). Ab numbers **viewer-independent** hain:
   - FMS contribution hamesha all-doers crediting se nikalta hai (role-independent).
   - Role sirf ye decide karta hai ki **kaun-kaun employee dikhega** (HOD → apna dept;
     Admin/PC → sab), kisi employee ke **numbers kabhi nahi badalte**.
   - Yahi fix `/api/mis/all` (All MIS) me bhi laga diya gaya hai.

4. **Employee par click → pending ka pura breakdown** — Records me kisi employee par click
   karne par modal khulta hai jisme:
   - **Total**, **✅ Done total**, **⏳ Pending total**, **⏰ Overdue**, **🔄 Revised**.
   - Delegation / Checklist / FMS ka done/total mini-breakdown.
   - **Konse tasks pending hain** — Delegation, Checklist aur FMS teeno ke pending tasks ki
     poori list (description + date + overdue/late flag).

5. **Search + Department filter + CSV export** — Records tab me employee search, (Admin ke
   liye) department dropdown, aur ek click me CSV export.

### Files changed (vs v16)
| File | Change |
|---|---|
| `server.js` | 🆕 `/api/employee-records` (canonical, role-independent per-employee record + pending task lists)<br>🆕 `computeFmsStats(hodDept, collectPending)` ab pending FMS rows bhi collect karta hai<br>🔧 `/api/mis/all` FMS crediting ab role-independent (`computeFmsStats('')`) |
| `public/app.html` | 🆕 Sidebar "Records" nav (admin/hod/pc)<br>🆕 `page-records` + detail modal + saara JS (`loadRecords`/`generateRecords`/`renderRecords`/`openRecordDetail`/`exportRecords`)<br>🔧 `openSetPlanModal(empId, week)` ab inline pre-select support karta hai (PC bhi) |

---

# Sohan Healthcare - Task Manager (v16)

## What's New in v16

1. **Assigned Date column** — All Tasks aur "Delegate by Me" me ab dikhta hai ki
   task kis date ko delegate hua tha (`created_at` column se).
2. **FMS Tasks me Search Bar** — Step ke pending rows me search filter — kisi bhi
   column ki value type karke turant matches dekho.
3. **FMS Tasks me Sticky + Bigger Headers** — Column headers ab 13px (pehle 11px),
   bold black color, aur scroll karne par bhi top par chipke rehte hain (freeze).
4. **PC Dashboard FMS Drilldown** — PC role ke liye naya dropdown: FMS select karte
   hi har step ka pending/done/total count, doer names, aur progress bar dikhte hain.
   (Sirf PC role ko visible; admin/HOD ka existing view unchanged.)
5. **Transfer me Upcoming Checklist Tasks** — Pehle sirf today aur past ki checklist
   transfer hoti thi. Ab future ki checklist (kal/parso/agle hafte) bhi transfer
   modal me select karke transfer kar sakte ho.
6. **Smart Bulk Delete**
   - Pehle **frequency category** select karna mandatory (daily/weekly/monthly/...).
     Employee dropdown tab tak disabled rehta hai jab tak category select na ho.
   - Sirf selected category ki tasks delete hongi (sab ek saath nahi).
   - **Completed tasks NEVER delete** — bulk delete ke har flow me wo safe hain
     (per-date list me bhi nahi dikhte; year-delete bhi unhe skip karta hai).
7. **Daily Delegation Reminder Emails (12:00 PM)**
   - Delegation tasks ke liye automatic mail jaata hai due date se **2 din pehle se**.
   - Roz 12:00 PM par — jab tak task complete ya delete na ho.
   - Ek user ke multiple tasks **ek hi mail me** group hote hain.
   - Agar **ek email account 3-4 employees use karte hain** (shared inbox), to
     mail me har user ka naam alag section me dikhta hai — pata rahega ki kiska
     reminder hai.
   - Same task ek din me 2 baar reminder nahi bhejta (`last_reminder_date` track).

---

## 📁 Upload Karne Wali Files

```
project_root/
├── server.js          ✅ Main app (v16 — reminder cron + new endpoints)
├── package.json       ✅ Dependencies (no change vs v15)
├── .env               ⚠️  .env.example se copy karke banao
├── .env.example       ✅ Template
├── credentials.json   ✅ Google Sheets API
└── public/
    ├── index.html     ✅ Login page (unchanged)
    ├── app.html       ✅ Main app (v16 — all UI updates)
    └── shpl-logo.webp ✅ Logo (unchanged)
```

⚠️ **`node_modules/` upload MAT karo** — server khud install kar lega (auto-install
bootstrap server.js ke top par hai, jaise v14+ me tha).

---

## 🚀 Hostinger Setup — 4 Steps (No SSH needed)

### Step 1: Files upload karo
Saari project files Hostinger File Manager se upload karo. `.env` aur
`credentials.json` zaroor upload karna.

### Step 2: Gmail App Password (agar pehle se nahi kiya)
- https://myaccount.google.com/security → 2-Step Verification ON
- https://myaccount.google.com/apppasswords → naya App Password
- 16-char password mile to spaces hata ke save karo

### Step 3: `.env` file
```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=your_db_password
DB_NAME=task_manager
NODE_ENV=production
PORT=3000
SESSION_SECRET=any_random_long_string
SMTP_USER=yourgmail@gmail.com
SMTP_PASS=abcdefghijklmnop
SMTP_FROM_NAME=Sohan Healthcare Task Manager
APP_URL=https://yourdomain.com
```

### Step 4: hPanel se Restart
- Hostinger hPanel → Node.js section → Restart
- Console me expected logs:
  ```
  ✅ MySQL Connected Successfully!
  ✅ DB migrations checked
  ✅ Gmail SMTP Ready
  ✅ Google Auth pre-warmed
  ✅ Delegation reminder scheduler started (fires daily at 12:00 PM)
  ```

Pehli baar restart me 1-2 minute (auto-install). Uske baad seconds me start.

---

## 📧 Delegation Reminder — Kab kaam karega

**Trigger**: roz 12:00 PM (Node server ke local timezone me — Hostinger me usually
IST hi hota hai, par confirm karne ke liye console log dekho).

**Filter logic**:
- `status = 'pending'`
- `due_date <= today + 2` (do din pehle se reminder shuru)
- `last_reminder_date < today` (aaj already reminder bheji to skip)

**Group rule**: Same `notification_email` ke saare users ke saare pending tasks ek
hi mail me — har user ke liye alag section.

**Stop rule**: Task complete ya delete hote hi mail aana automatically band.

**Manual trigger** (admin testing ke liye):
```
POST /api/admin/run-reminders
```
JWT cookie admin ka chahiye. Useful agar 12 PM miss ho gaya ho ya test karna ho.

---

## ⚠️ Reminder Scheduler — Server Restart Behavior

Scheduler ek in-memory flag use karta hai (`_lastReminderRunDate`) jo har 60
seconds tick check karta hai. Edge cases:

| Server start time | Behavior |
|---|---|
| < 12:00 PM | Wait karega, fir 12:00 PM par fire hoga |
| 12:00 PM ke baad (same din me pehli baar) | Seedha fire ho jaayega (catch-up) |
| 12:00 PM ke baad (already fire ho chuki hai DB me) | Fire to hoga, par DB filter `last_reminder_date < today` ki vajah se 0 emails jaayengi (no duplicates) |

DB column duplicates ke against safe hai. Sirf **bahut** rare edge case: agar Node
process 11:59 → 12:01 ke 2-min window me crash ho jaaye to us din 1-2 mail miss ho
sakti hain — manual `/api/admin/run-reminders` se catch up kar lo.

---

## 🗑 Bulk Delete — New Flow Summary

**Pehla flow (per-date)**: Doer → Date → tasks list (completed wali hide) → select
karke delete. `skipCompleted=1` server-side safety bhi lagi hui hai.

**Doosra flow (bulk by frequency)**:
1. Frequency category select (Daily/Weekly/Monthly/...)
2. Employee dropdown unlock — usme se select karo
3. Count check + confirmation
4. Sirf us category ki pending/revised tasks delete (completed skip)

**Note**: Purane checklist tasks jinki `frequency` blank hai (v15 ke pehle banaye
hue), unko delete karne ke liye "All categories" select karo.

---

## 📝 What Changed (vs v15)

| File | Change |
|---|---|
| `server.js` | 🆕 Migrations: `created_at` on tasks, `frequency` on checklist, `last_reminder_date` on delegation<br>🆕 `/api/tasks` returns `assigned_on` + supports `includeFuture=1`<br>🆕 `bulk-checklist` saves `frequency`<br>🆕 `checklist-year-count` + `checklist-year-delete` take `frequency` filter, skip completed<br>🆕 Single + user-bulk delete skip completed (with `skipCompleted=1` safety flag)<br>🆕 Daily reminder scheduler + `runDelegationReminders()` + `/api/admin/run-reminders` |
| `public/app.html` | 🆕 All Tasks + DBM: "Assigned On" column<br>🆕 FMS Tasks: search bar + sticky/bigger headers (CSS + new render/filter functions)<br>🆕 PC dashboard: FMS step-detail dropdown panel<br>🆕 Transfer modal: uses `includeFuture=1` for checklist<br>🆕 Bulk delete: frequency dropdown, completed-task filter, updated copy<br>🆕 Checklist creation (form + CSV) passes `frequency` |
| `README.md` | This file — v16 changelog |

---

## 🔧 Troubleshooting

**Q: Reminder mail nahi aa rahi**
- Console me `✅ Delegation reminder scheduler started` log dikh raha hai?
- `.env` me `SMTP_USER` + `SMTP_PASS` set hain?
- User ke profile me `notification_email` filled hai?
- 12:00 PM ke baad `🔔 Reminder pass @ YYYY-MM-DD: N email(s) sent` log expected
- Manual test: `POST /api/admin/run-reminders` (admin auth)
- Spam folder check karo (pehli baar normal hai)

**Q: FMS search work nahi kar raha**
- Sirf displayed columns me match karta hai (jo show_cols me set hain)
- Empty search me sab rows wapas dikh jaate hain

**Q: Bulk delete me frequency dropdown blank hai**
- Migration successful hui? Console me `✅ DB migrations checked` dikhna chahiye
- Purane tasks (v15) ki frequency blank rahegi — "All categories" use karo

**Q: Transfer me checklist task nahi dikh rahi for a future date**
- v16 me `includeFuture=1` apne aap pass hota hai — agar fir bhi nahi dikhi, browser
  cache clear karke try karo (Ctrl+Shift+R)

**Q: Assigned On column "—" dikha raha hai**
- Purane tasks (migration ke pehle banaye hue) me `created_at` empty ho sakta hai
- Naye tasks me `created_at` automatic fill hota hai (DEFAULT CURRENT_TIMESTAMP)
