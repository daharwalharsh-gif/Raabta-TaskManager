// ══════════════════════════════════════════════════════
// WhatsApp API config (Waumfy) — YEH AAPKI LIVE SETTINGS HAI
// ══════════════════════════════════════════════════════
// DHYAN DO: ye file git me TRACKED hai aur repo PUBLIC hai — yahan likhi key
// GitHub par sabko dikhti hai. Harsh ne 20 Aug ko saaf kaha: credentials .env
// me NAHI, isi file me (code me) rahenge — waisa hi hai.
//
// NAYA WAUMFY API (Harsh, 22 Aug 2026): purane Aumpfy trigger ki jagah ab
// seedha Waumfy ka send-message API. Test kiya lagate waqt: HTTP 200 sirf
// 0.4 SECOND me (purana trigger 50-90s leta tha), number wahi purana
// 919999298678 (Task Manager). Body ka shape bhi naya: {phone, message}
// (pehle {to, text} tha) — niche phoneField/messageField isi liye badle hain.
// Delegation, checklist, daily reminder — sab isi se jaate hain. Delay,
// reminder time, outbox — sab pehle jaisa (Harsh: "sab same rakhna").
//
// API change ho to yahan url / apiKey (aur zaroorat ho to format) badlo,
// phir app RESTART karo. Bas.
// ══════════════════════════════════════════════════════
module.exports = {
  enabled: true,

  // ── Waumfy send-message — delegation, checklist, daily reminder ──
  url:    'https://www.waumfy.com/api/v1/send-message',
  apiKey: 'wag_sk_442465130360706f106c575e40901f36ac9e84d9',

  // ── Body ka shape: {"phone": "...", "message": "..."} ──
  authHeader:   'x-api-key',
  phoneField:   'phone',
  messageField: 'message',

  // ── PMS / FMS sheet ke message (ABHI RUKE HAIN — niche fmsNotifyEnabled) ──
  // ⚠️ DHYAN: ye PURANE Aumpfy trigger format ka hai jo {to, text} leta tha.
  // Upar phoneField/messageField ab {phone, message} hain — isliye FMS ko
  // wapas chalu karne se PEHLE is block ko bhi naye Waumfy API par le jaana
  // hoga (ya iske liye alag field-mapping banani hogi). Abhi fmsNotifyEnabled
  // false hai to koi farak nahi padta.
  pms: {
    url:    'https://api.aumpfy.com/api/apis/trigger/pms-08a73f',
    apiKey: 'sl_ae88d0d5e8e084c46ac9faeedc2993c15d374ba03fdb7e9d470e77d31975bd47'
  },

  // ⛔ PMS/FMS SHEET NOTIFICATION ROKI HUI (Harsh, 20 Aug 2026): "jab me
  // bolunga tab bhejna." Ye SIRF sheet-based PMS/FMS message rokta hai —
  // delegation/checklist assign-time alert aur subah-shaam daily reminder
  // ispar bilkul asar nahi. Resume karne ke liye ye wapas true karo (aur
  // upar wala ⚠️ pehle padho).
  fmsNotifyEnabled: false,

  // Ek API baithi ho to message doosri (chalu) API se bhej dun? Default false
  // — har message apni hi API se, kabhi cross nahi.
  allowApiFallback: false,

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
  timeoutMs:    60000,   // naya API 0.4s me jawab deta hai; buffer ke liye same rakha
  appUrl:       process.env.APP_URL || ''
};
