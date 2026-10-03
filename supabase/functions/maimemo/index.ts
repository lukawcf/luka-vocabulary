// Luka Vocabulary — relay to the MaiMemo (墨墨背单词) open API.
//
// MaiMemo answers the browser's CORS preflight but not the real response, so the page cannot call
// open.maimemo.com directly. The page sends {path, body, token} here and this function makes the
// call server-to-server.
//   - only signed-in visitors (anonymous sign-ins count) may use it, so it is not an open proxy
//   - only the read-only study endpoints the page needs are allowed
//   - the learner's MaiMemo token is passed through for this one call; it is never stored or logged
// MaiMemo's status code and JSON body are returned unchanged.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
function serverKey() {
  const legacy = env("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  try { return Object.values(JSON.parse(env("SUPABASE_SECRET_KEYS", "{}")))[0] as string; } catch { return ""; }
}
const admin = createClient(env("SUPABASE_URL"), serverKey());

const MAIMEMO = "https://open.maimemo.com/open/api/v1/memo/";
const ALLOWED = new Set(["study/get_today_items", "study/get_study_progress"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ code: "method" }, 405);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(jwt);
  if (!auth?.user) return json({ code: "unauthorized" }, 401);

  let input: { path?: unknown; body?: unknown; token?: unknown };
  try { input = await req.json(); } catch { return json({ code: "bad_request" }, 400); }
  const path = String(input.path ?? "");
  const token = String(input.token ?? "").trim();
  if (!ALLOWED.has(path)) return json({ code: "path_not_allowed" }, 400);
  if (!token || token.length > 400) return json({ code: "mm_auth" }, 401);

  let res: Response;
  try {
    res = await fetch(MAIMEMO + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input.body ?? {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return json({ code: "mm_network" }, 502);
  }
  const text = await res.text();
  return new Response(text || "{}", { status: res.status, headers: { ...cors, "Content-Type": "application/json" } });
});
