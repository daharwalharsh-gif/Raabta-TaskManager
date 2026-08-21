// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — YEH AAPKI LIVE SETTINGS HAI
// ══════════════════════════════════════════════════════
// DHYAN DO: ye file git me TRACKED hai aur repo PUBLIC hai — yahan likhi key
// GitHub par sabko dikhti hai. Harsh ne 20 Aug ko saaf kaha: credentials .env
// me NAHI, isi file me (code me) rahenge — waisa hi hai.
//
// DO ALAG API (20 Aug 2026, shaam — Harsh ka faisla):
//   1) niche wali url/apiKey     -> delegation, checklist, daily reminder
//   2) niche wali pms.url/apiKey -> PMS/FMS sheet ke notification
// Dono seedha test karke pakka kiya, dono chalu hain (HTTP 200, 3 sec).
//
// API change ho to yahan url / apiKey (aur zaroorat ho to format) badlo,
// phir app RESTART karo. Bas.
// ══════════════════════════════════════════════════════
module.exports = {
  // ✅ WAPAS CHALU (Harsh, 21 Aug 2026): 20 Aug ko Nishant ko ek reminder 6
  // baar jaane par sab band kiya tha. Root cause fix ho chuka hai (timeout =
  // "pahuncha ho sakta hai" => kabhi auto-resend nahi; + har bande ko din me
  // AM ka reminder ek hi baar, PM ka ek hi baar). Ab duplicate impossible.
  enabled: true,

  // ── Aumpfy trigger — delegation, checklist, daily reminder ──
  url:    'https://api.aumpfy.com/api/apis/trigger/raabta-testing-c63350',
  apiKey: 'sl_a2032fc2f044d50a336e3d15ca9106ec6e17a51d1dd212ddef2e3b670601410a',

  // ── Trigger body ka shape (naya trigger alag maange to yahan badlo) ──
  authHeader:   'x-api-key',
  phoneField:   'to',
  messageField: 'text',

  // ── PMS / FMS sheet ke message ALAG API se jaate hain ──
  // Ye apni alag WhatsApp session (pms wala phone, 919711718322) use karta
  // hai. Delegation, checklist aur daily reminder upar wale se hi jaate hain
  // — unhe yahan se koi farak nahi padta.
  pms: {
    url:    'https://api.aumpfy.com/api/apis/trigger/pms-08a73f',
    apiKey: 'sl_ae88d0d5e8e084c46ac9faeedc2993c15d374ba03fdb7e9d470e77d31975bd47'
  },

  // ⛔ PMS/FMS SHEET NOTIFICATION ROKI HUI (Harsh, 20 Aug 2026): "jab me
  // bolunga tab bhejna." Ye SIRF sheet-based PMS/FMS message rokta hai —
  // delegation/checklist assign-time alert aur subah-shaam daily reminder
  // ispar bilkul asar nahi, wo alag `enabled` flag se chalte hain aur chalte
  // rahenge. Resume karne ke liye ye wapas true karo.
  fmsNotifyEnabled: false,

  // Ek API baithi ho to message doosri (chalu) API se bhej dun? Default false
  // — delegation/checklist/reminder hamesha apni API se, PMS hamesha apni se,
  // kabhi cross nahi. true karoge to atkane par doosri se jaayega, par bande
  // ko number alag dikhega.
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
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};
