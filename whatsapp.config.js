// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — YEH AAPKI LIVE SETTINGS HAI
// ══════════════════════════════════════════════════════
// DHYAN DO: ye file git me TRACKED hai aur repo PUBLIC hai — yahan likhi key
// GitHub par sabko dikhti hai. Surakshit tareeka: key .env / Hostinger panel me.
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

  // ── PMS / FMS sheet ke message ALAG API se jaate hain ──
  // Ye apni alag WhatsApp session (pms wala phone) use karta hai. Delegation,
  // checklist aur daily reminder upar wale (default) API se hi jaate hain —
  // unhe yahan se koi farak nahi padta.
  pms: {
    url:    'https://api.aumpfy.com/api/apis/trigger/pms-08a73f',
    apiKey: 'sl_ae88d0d5e8e084c46ac9faeedc2993c15d374ba03fdb7e9d470e77d31975bd47'
  },

  // Ek API baithi ho to message doosri (chalu) API se bhej dun?
  // Harsh ne 20 Aug ko saaf mana kiya — "purani API se hi jana chahiye".
  // Message tab bhi gum nahi hota: apni hi API ka intezaar karta hai aur wo
  // theek hote hi chala jaata hai. true karoge to doosri se bhi jaane lagega,
  // par bande ko number alag dikhega.
  allowApiFallback: false,

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
