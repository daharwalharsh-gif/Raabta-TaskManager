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
// Harsh ne 20 Aug (dopahar baad) ko endpoint wapas raabta-testing-c63350 par
// kar diya, key wahi rakhi (pms wali, sl_ae88…). DHYAN DO: maine ye badalne se
// PEHLE seedha test kiya (bina code ke, sirf HTTP POST) — ye endpoint 100
// second tak koi jawab nahi de raha, chahe koi bhi key lagao (galat key par
// turant 401 aata hai, matlab endpoint zinda hai; asli message par kuch nahi
// hota — session-level dikkat hai, Waumfy ke andar). Jab tak wahan session
// dobara nahi judta, is URL se message nahi jayenge — enabled:false hone ki
// wajah se abhi kuch bhej hi nahi raha, isliye ye filhaal bekaar nahi ja raha.
//
// API change ho to niche url / apiKey (aur zaroorat ho to format) badlo,
// phir app RESTART karo. Bas.
// ══════════════════════════════════════════════════════
module.exports = {
  // ⛔ ROKA HUA (Harsh, 20 Aug 2026): koi bhi WhatsApp message — pending
  // backlog, naya assign-time alert, reminder, PMS/FMS — kuch bhi nahi jaayega
  // jab tak ye wapas true na ho. Backlog DB (WA_Outbox) me surakshit padha
  // rahega, gum nahi hoga — resume karte hi wahin se chalega.
  enabled: false,

  // ── Aumpfy trigger — SAARE message isi se jaate hain ──
  url:    'https://api.aumpfy.com/api/apis/trigger/raabta-testing-c63350',
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

  // Office hours rule: reminders sirf 10:00 AM – 7:00 PM IST me jaate hain
  // (guard server.js me isi list ke pehle slot se apne aap match hoti hai)
  reminderTimes: [ { h: 10, m: 0 }, { h: 16, m: 0 } ],   // 10:00 AM & 4:00 PM
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};

// ── PICHLI CHALU API (pms-08a73f) — sirf record ke liye ──
// url:    'https://api.aumpfy.com/api/apis/trigger/pms-08a73f'
// apiKey: 'sl_ae88d0d5e8e084c46ac9faeedc2993c15d374ba03fdb7e9d470e77d31975bd47'
// (yahi key hai jo ab upar bhi lagi hai) Ye endpoint 20 Aug dopahar tak chalu
// tha (seedha test se pakka). Upar wale se kaam na bane to isse wapas jaa
// sakte ho — bas url yahan se copy karo.
