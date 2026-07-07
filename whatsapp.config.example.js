// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — TEMPLATE / EXAMPLE
// ══════════════════════════════════════════════════════
// Is file ko copy karke  whatsapp.config.js  banao aur usme apni asli values
// daalo. whatsapp.config.js gitignored hai — aapki API key GitHub par kabhi
// nahi jayegi.
//
// Jab bhi aapki API change ho: sirf whatsapp.config.js me url / apiKey / format
// badlo aur app RESTART kar do. Kisi aur file ko haath lagane ki zaroorat nahi.
// ══════════════════════════════════════════════════════
module.exports = {
  // WhatsApp alerts ON/OFF
  enabled: (process.env.WHATSAPP_ENABLED || 'true').toLowerCase() !== 'false',

  // ── Aumpfy trigger (apne Aumpfy dashboard se) ──
  url:    process.env.AUMPFY_API_URL || 'https://api.aumpfy.com/api/apis/trigger/your-trigger-slug',
  apiKey: process.env.AUMPFY_API_KEY || 'sl_your_api_key_here',

  // ── Trigger jo body maangta hai uska shape ──
  // Naya trigger alag fields maange to SIRF ye 3 lines badlo.
  authHeader:   'x-api-key',   // header jisme API key jaati hai
  phoneField:   'to',          // number wala field  (kuch triggers me 'phone')
  messageField: 'text',        // message wala field (kuch triggers me 'message')

  // ── Baaki settings ──
  countryCode:  (process.env.WHATSAPP_COUNTRY_CODE || '91').replace(/\D/g, ''), // 10-digit number ke aage lagega
  reminderHour: parseInt(process.env.WHATSAPP_REMINDER_HOUR) || 10,             // daily reminder (24h, server time)
  timeoutMs:    20000,
  appUrl:       process.env.APP_URL || ''   // message me "Open:" link ke liye
};
