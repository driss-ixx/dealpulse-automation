import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_GROUPS = [
  { id: "bonplansfrance", name: "Bons Plans France" },
  { id: "bonplansamazonfrance", name: "Bons Plans Amazon France" },
  { id: "promos.fr", name: "Promos.fr" },
];

async function postToFbGroup(
  userToken: string, groupId: string, message: string
): Promise<boolean> {
  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${groupId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: userToken })
    });
    const data = await resp.json();
    if (data.id) { console.log(`FB Group ${groupId} posted:`, data.id); return true; }
    console.error(`FB Group ${groupId} error:`, JSON.stringify(data));
    return false;
  } catch { return false; }
}

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: configRows } = await supabase.from("bot_config").select("key,value");
  const config: Record<string, string> = {};
  for (const row of (configRows || [])) config[row.key] = row.value;

  const userToken = config["FACEBOOK_USER_TOKEN"];
  if (!userToken) {
    return new Response(JSON.stringify({ success: false, reason: "FACEBOOK_USER_TOKEN missing" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  const groups = config["FACEBOOK_GROUP_IDS"]
    ? JSON.parse(config["FACEBOOK_GROUP_IDS"])
    : DEFAULT_GROUPS;

  const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data: deals } = await supabase
    .from("posted_deals")
    .select("title, url, score")
    .gte("posted_at", since)
    .gte("score", 7)
    .is("fbgroup_posted", null)
    .order("score", { ascending: false })
    .limit(2);

  if (!deals || deals.length === 0) {
    return new Response(JSON.stringify({ success: true, reason: "no eligible deals" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  let posted = 0;
  for (const deal of deals) {
    const message = `🔥 ${deal.title}\n\n🤖 Score IA : ${deal.score}/10 — Deal validé par IA\n\n🔗 ${deal.url}\n\n#BonPlan #DealPulseFR`;
    let success = false;
    for (const group of groups) {
      const ok = await postToFbGroup(userToken, group.id, message);
      if (ok) { success = true; break; }
      await new Promise(r => setTimeout(r, 1500));
    }
    if (success) {
      await supabase.from("posted_deals").update({ fbgroup_posted: new Date().toISOString() }).eq("url", deal.url);
      posted++;
    }
  }

  return new Response(JSON.stringify({ success: true, deals_posted_fbgroups: posted }), {
    headers: { "Content-Type": "application/json" }
  });
});
