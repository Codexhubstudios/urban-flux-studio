// URBAN FLUX STUDIO — Cloudflare Worker
// Model: FLUX.2 [klein] 9B (@cf/black-forest-labs/flux-2-klein-9b) on Cloudflare GPUs
// Weights are NOT stored in GitHub — GitHub hosts this code only.

const CF_ACCOUNT = "388763a7870ed8bcf5adddc39e6d6180";
const MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function runFluxRetry(env, fields, attempts = 3) {
  // The 9B endpoint occasionally returns a transient 500 — retry automatically
  let last;
  for (let i = 0; i < attempts; i++) {
    const res = await runFlux(env, fields);
    if (res.ok) return res;
    last = res;
    await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  return last;
}

async function runFlux(env, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${MODEL}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: fd,
  });
}

function dataUrlToBlob(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return null;
  const bin = atob(m[2]);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: m[1] });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health")
      return json({
        ok: true,
        app: "URBAN FLUX STUDIO",
        model: MODEL,
        hardware: "Cloudflare Workers AI GPU",
        capabilities: ["text-to-image", "image upload + description edit"],
      });

    // ---------- TEXT -> IMAGE ----------
    if (url.pathname === "/api/generate" && request.method === "POST") {
      try {
        const { prompt } = await request.json();
        if (!prompt || !String(prompt).trim()) return json({ error: "prompt required" }, 400);
        const res = await runFluxRetry(env, { prompt: String(prompt).slice(0, 2000) });
        if (!res.ok)
          return json({ error: "model failed", detail: (await res.text()).slice(0, 300) }, 502);
        const data = await res.json();
        const img = data?.result?.image;
        if (!img) return json({ error: "no image returned" }, 502);
        return json({ ok: true, image: img, mime: "image/jpeg" });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // ---------- IMAGE + DESCRIPTION -> EDITED IMAGE ----------
    if (url.pathname === "/api/edit" && request.method === "POST") {
      try {
        const { prompt, imageDataUrl } = await request.json();
        if (!imageDataUrl || !prompt) return json({ error: "prompt and image required" }, 400);
        const blob = dataUrlToBlob(imageDataUrl);
        if (!blob) return json({ error: "invalid image data URL" }, 400);
        if (blob.size > 4 * 1024 * 1024) return json({ error: "image too large (max 4MB)" }, 413);
        const res = await runFluxRetry(env, {
          prompt: String(prompt).slice(0, 2000),
          image: blob,
        });
        if (!res.ok)
          return json({ error: "edit failed", detail: (await res.text()).slice(0, 300) }, 502);
        const data = await res.json();
        const img = data?.result?.image;
        if (!img) return json({ error: "no image returned" }, 502);
        return json({ ok: true, image: img, mime: "image/jpeg" });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    return json({ error: "not found", routes: ["/api/generate", "/api/edit"] }, 404);
  },
};
