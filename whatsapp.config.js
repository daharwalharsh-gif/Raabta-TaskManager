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
  url:    'https://api.aumpfy.com/api/apis/trigger/test-33b45a',
  apiKey: 'sl_105e1260927eaba1a0021584c1cf0e154dc44757afb7c04aee22df54e0dd6d96',

  // ── Trigger body ka shape (naya trigger alag maange to yahan badlo) ──
  authHeader:   'x-api-key',
  phoneField:   'to',
  messageField: 'text',

  // ── Baaki settings ──
  countryCode:  '91',
  reminderHour: 10,
  timeoutMs:    60000,   // Aumpfy real-number send can take ~50s to respond
  appUrl:       process.env.APP_URL || ''
};
