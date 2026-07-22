// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — YEH AAPKI LIVE SETTINGS HAI
// ══════════════════════════════════════════════════════
// Ye file GitHub par NAHI jaati (gitignored). Apni API yahin manage karo.
// API change ho to niche  url / apiKey  (aur zaroorat ho to format) badlo,
// phir app RESTART karo. Bas.
// ══════════════════════════════════════════════════════
module.exports = {
  enabled: true,

  // ── Aumpfy trigger ──
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

  // Office hours rule: reminders sirf 11:00 AM – 7:00 PM IST me jaate hain
  reminderTimes: [ { h: 10, m: 40 }, { h: 17, m: 0 } ],   // 10:40 AM & 5:00 PM
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};
