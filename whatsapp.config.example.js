// ══════════════════════════════════════════════════════
// WhatsApp API config (Aumpfy) — TEMPLATE / EXAMPLE
// ══════════════════════════════════════════════════════
// ⚠️  API key kabhi bhi code me mat likho aur git me mat daalo — repo public
//     hai, aur uski koi bhi copy aapke WhatsApp se message bhejne lagegi.
//
// SAHI TARIKA (production): Hostinger hPanel → Environment variables me
//     AUMPFY_API_URL  aur  AUMPFY_API_KEY  set karo. Ye file wahin se padhti hai.
//
// Local dev me chaho to  whatsapp.config.js  bana lo (wo gitignored hai).
// API change ho to sirf env var badlo aur app restart karo.
// ══════════════════════════════════════════════════════
const _url = process.env.AUMPFY_API_URL || '';
const _key = process.env.AUMPFY_API_KEY || '';
// Credentials set hi na hon to WhatsApp band rakho — placeholder se failed
// send karke logs bharne ka koi fayda nahi.
const _configured = _url.startsWith('http') && _key.startsWith('sl_');
if (!_configured) {
  console.log('  WhatsApp NOT configured — AUMPFY_API_URL / AUMPFY_API_KEY env vars set karo');
}

module.exports = {
  // WhatsApp alerts ON/OFF (credentials na hon to apne aap OFF)
  enabled: _configured && (process.env.WHATSAPP_ENABLED || 'true').toLowerCase() !== 'false',

  // ── Aumpfy trigger (sirf env se — hardcode mat karo) ──
  url:    _url,
  apiKey: _key,

  // ── Trigger jo body maangta hai uska shape ──
  // Naya trigger alag fields maange to SIRF ye 3 lines badlo.
  authHeader:   'x-api-key',   // header jisme API key jaati hai
  phoneField:   'to',          // number wala field  (kuch triggers me 'phone')
  messageField: 'text',        // message wala field (kuch triggers me 'message')

  // ── Baaki settings ──
  countryCode:  (process.env.WHATSAPP_COUNTRY_CODE || '91').replace(/\D/g, ''), // 10-digit number ke aage lagega
  // Task assign karte waqt turant WhatsApp bheje? false = assign-time message
  // band (daily reminders phir bhi jaate hain).
  notifyOnAssign: false,

  // Daily reminder times (IST). Add/remove entries to change kab reminder jaye.
  // Office hours rule: reminders sirf 11:00 AM – 7:00 PM IST me jaate hain.
  reminderTimes: [ { h: 11, m: 0 }, { h: 17, m: 0 } ],   // 11:00 AM & 5:00 PM
  timeoutMs:    60000,
  appUrl:       process.env.APP_URL || ''   // message me "Open:" link ke liye
};
