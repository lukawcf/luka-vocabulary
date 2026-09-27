// Supabase settings for the free cloud mode. Both values are public (the anon key only works
// within the row level security rules), so this file is safe to commit.
// Leave them empty to run the app in local mode (progress in this browser, own API key).
window.LUKA_CONFIG = {
  supabaseUrl: "",          // Project Settings → API → Project URL, e.g. https://xxxx.supabase.co
  supabaseAnonKey: "",      // Project Settings → API → anon public key
  turnstileSiteKey: "",     // optional: Cloudflare Turnstile site key, if CAPTCHA is enabled in Supabase Auth
};
