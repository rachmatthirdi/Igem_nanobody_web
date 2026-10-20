// Downloads the models that are otherwise fetched on a user's first request
// (DiscoTope's ESM-IF1 weights, CodonTransformer's model), by making the same
// API calls a user would. Run once after the first start:
//
//   docker compose exec app node scripts/prewarm.js
//
// Needs the server to be listening (default http://127.0.0.1:3000).

const base = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
let cookie = "";

async function api(channel, args) {
  const res = await fetch(`${base}/api/${channel}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-NB-Request": "1", Cookie: cookie },
    body: JSON.stringify({ args }),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${channel}: ${data.error || res.status}`);
  return data.result;
}

async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`${name} ... `);
  try {
    const r = await fn();
    console.log(`ok (${Math.round((Date.now() - t0) / 1000)} s)`);
    return r;
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    process.exitCode = 1;
  }
}

(async () => {
  const pdb = await step("fetch 1ZVH", () => api("fetch-pdb", ["1ZVH"]));
  if (!pdb) return;
  await step("FreeSASA", () => api("run-freesasa", [{ chainAPath: pdb.chainAPath }]));
  await step("DiscoTope-3.0 (downloads ESM-IF1 weights on first run)", () =>
    api("run-discotope", [{ chainAPath: pdb.chainAPath, pdbId: "1ZVH" }]),
  );
  await step("scaffold", () => api("get-scaffold-sequence", [{ scaffoldName: "3DWT" }]));
  await step("CodonTransformer (downloads its model on first run)", () =>
    api("codon-optimize", [{ aminoAcidSeq: "MKTAYIAKQRQISFVKSHFSRQ" }]),
  );
  console.log(process.exitCode ? "Finished with errors." : "All models are cached.");
})();
