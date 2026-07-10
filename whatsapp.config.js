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
  url:    'https://api.aumpfy.com/api/apis/trigger/raabta-12da4f',
  apiKey: 'sl_17121ec0ac008ed668d3ebe39aa7f61036e31ce24cd6a6440877046d6cf8241c',

  // ── Trigger body ka shape (naya trigger alag maange to yahan badlo) ──
  authHeader:   'x-api-key',
  phoneField:   'to',
  messageField: 'text',

  // ── Baaki settings ──
  countryCode:  '91',
  // Daily reminder times (IST). Add/remove entries to change kab reminder jaye.
  reminderTimes: [ { h: 10, m: 0 }, { h: 17, m: 30 } ],   // 10:00 AM & 5:30 PM
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};
