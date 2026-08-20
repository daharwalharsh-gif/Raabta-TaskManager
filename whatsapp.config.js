// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — YEH AAPKI LIVE SETTINGS HAI
// ══════════════════════════════════════════════════════
// DHYAN DO: ye file git me TRACKED hai aur repo PUBLIC hai — yahan likhi key
// GitHub par sabko dikhti hai. Harsh ne 20 Aug ko saaf kaha: credentials .env
// me NAHI, isi file me (code me) rahenge — waisa hi hai.
//
// EK HI PHONE, SAARE MESSAGE (20 Aug 2026 se): delegation, checklist, daily
// reminder, aur PMS/FMS sheet ke notification — SAB isi ek niche wali
// url/apiKey se jaate hain. Pehle do alag API thi (ek delegation/reminder ke
// liye, doosri PMS ke liye) — Harsh ne ek hi kar diya.
//
// Niche wala number ABHI CHALU hai (919711718322 — "pms" session waala). Jo
// pehle wali API thi (raabta-testing-c63350, number 919999298678) wo 19 Aug
// shaam se jawab nahi de rahi (session-level dikkat, Waumfy ke andar — dekho
// end ka comment). Isliye jo chalu hai wahi laga di, taaki message rukein na.
//
// API change ho to niche url / apiKey (aur zaroorat ho to format) badlo,
// phir app RESTART karo. Bas.
// ══════════════════════════════════════════════════════
module.exports = {
  enabled: true,

  // ── Aumpfy trigger — SAARE message isi se jaate hain ──
  url:    'https://api.aumpfy.com/api/apis/trigger/pms-08a73f',
  apiKey: 'sl_ae88d0d5e8e084c46ac9faeedc2993c15d374ba03fdb7e9d470e77d31975bd47',

  // ── Trigger body ka shape (naya trigger alag maange to yahan badlo) ──
  authHeader:   'x-api-key',
  phoneField:   'to',
  messageField: 'text',

  // ── Baaki settings ──
  countryCode:  '91',
  // Daily reminder times (IST). Add/remove entries to change kab reminder jaye.
  // Task assign karte waqt turant WhatsApp bheje? false = koi assign-time
  // message nahi jaata (delegation, checklist, bulk — kisi ka bhi).
  // Daily reminders is se alag hain, wo chalte rehte hain.
  notifyOnAssign: true,

  // Office hours rule: reminders sirf 10:15 AM – 7:00 PM IST me jaate hain
  reminderTimes: [ { h: 10, m: 15 }, { h: 17, m: 0 } ],   // 10:15 AM & 5:00 PM
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};

// ── PURANI API (band, ab use nahi ho rahi) — sirf record ke liye ──
// url:    'https://api.aumpfy.com/api/apis/trigger/raabta-testing-c63350'
// apiKey: 'sl_a2032fc2f044d50a336e3d15ca9106ec6e17a51d1dd212ddef2e3b670601410a'
// Ye session (Waumfy → Phones → "Task Manager", 919999298678) kabhi reconnect
// ho jaye aur ispar wapas jana ho, to bas upar wala url/apiKey inse badal do —
// poore app me sab jagah yahi ek jagah se control hoti hai.
