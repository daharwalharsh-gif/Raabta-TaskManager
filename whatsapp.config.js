// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — YEH AAPKI LIVE SETTINGS HAI
// ══════════════════════════════════════════════════════
// DHYAN DO: ye file git me TRACKED hai aur repo PUBLIC hai — yahan likhi key
// GitHub par sabko dikhti hai. Harsh ne 20 Aug ko saaf kaha: credentials .env
// me NAHI, isi file me (code me) rahenge — waisa hi hai.
//
// EK HI PHONE, SAARE MESSAGE: delegation, checklist, daily reminder, aur
// PMS/FMS sheet ke notification — SAB isi ek niche wali url/apiKey se jaate
// hain.
//
// 20 Aug, shaam: session dobara jud gaya! Isi URL + is key ka test seedha
// (bina code ke) chalaya — HTTP 200, success:true, 3.2 second me jawab.
// Purana raasta wapas chalu hai — isliye ab RESUME (enabled:true) kar diya.
//
// API change ho to niche url / apiKey (aur zaroorat ho to format) badlo,
// phir app RESTART karo. Bas.
// ══════════════════════════════════════════════════════
module.exports = {
  // ✅ CHALU (Harsh, 20 Aug 2026 shaam): session reconnect ho gaya, isliye
  // resume kar diya. Assign karte hi (delegation/checklist) alert turant
  // jaayega, aur pending backlog bhi apne aap nikalna shuru ho jaayega.
  enabled: true,

  // ── Aumpfy trigger — SAARE message isi se jaate hain ──
  url:    'https://api.aumpfy.com/api/apis/trigger/raabta-testing-c63350',
  apiKey: 'sl_a2032fc2f044d50a336e3d15ca9106ec6e17a51d1dd212ddef2e3b670601410a',

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
  // (guard server.js me isi list ke pehle slot se apne aap match hoti hai)
  // Monday ko reminders skip hote hain (server.js me hardcoded) — Harsh ne
  // isi ko bar-bar confirm kiya hai.
  reminderTimes: [ { h: 10, m: 15 }, { h: 17, m: 0 } ],   // 10:15 AM & 5:00 PM
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};

// ── DOOSRI CHALU API (pms-08a73f) — sirf record ke liye ──
// url:    'https://api.aumpfy.com/api/apis/trigger/pms-08a73f'
// apiKey: 'sl_ae88d0d5e8e084c46ac9faeedc2993c15d374ba03fdb7e9d470e77d31975bd47'
// Ye bhi chalu hai (alag number, 919711718322). Upar wali kabhi baithe to
// isse wapas jaa sakte ho — bas url/apiKey yahan se copy karo.
