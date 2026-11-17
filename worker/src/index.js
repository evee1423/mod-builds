// Starling's Compile service on Cloudflare Workers: the door the game knows
// (packaging/android/build-server.txt in starling-client/starling), with this repository's
// GitHub Actions as the machines and its releases as the store. It replaces the gateway that
// lived on a paid VM (mod_build_gateway.py) and keeps the game's side as it was:
//
//   POST /v1/build?version=V   the mods (the game's bundle) in the body: {"job"}, or {"error"}
//   GET  /v1/job/J             {"state": "queued" | "building" | "done" | "failed", ...}
//   GET  /v1/job/J/lib         the library, from the `results` release (a redirect)
//
// The mods are sealed (AES-256-CTR, a key of their own) before they leave here, kept as an asset
// of the `requests` release under a random name, and the key goes to the build in its inputs,
// which only the run reads (build.yml, scripts/unseal.sh). The same mods on the same commit are
// the same job: what was built once is served again without a build.
//
// Secrets: GITHUB_APP_ID and GITHUB_APP_KEY (a GitHub App installed on this repository), or
// GITHUB_TOKEN, a fine-grained token for this repository only, with Actions and Contents read and
// write (`token`). A fork of this repository runs its own service with REPO, its "owner/name", in
// wrangler.toml's [vars] (README.md, "Your own build service"). Nothing about a player is kept: an
// address only counts its builds for a day, hashed, in this location's cache.

const MAIN_REPO = "starling-client/mod-builds";
// The repository the service builds in and stores to: env.REPO, the same for every request of a
// deployment, read at the start of each one.
let REPO = MAIN_REPO;
const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";
const downloads = () => `https://github.com/${REPO}/releases/download`;
const WORKFLOW = "build.yml";
const REQUESTS = "requests";
const RESULTS = "results";

// What the game sends at most (its LARGEST_REQUEST).
export const MAX_BODY = 32 << 20;
// Builds a day from one address, and from everyone through one Cloudflare location.
export const PER_ADDRESS = 9999;
export const PER_DAY = 9999;
const DAY = 24 * 3600;
// How long a build may take before the game is told it is lost (its own wait is 90 minutes).
const LONGEST = 80 * 60;
// How long the answer about a job on its way is held (`status`), and how often the hold looks for
// its answer. The game asks again 2 s after each answer and gives a read 40 s: at 6 s, the first
// evening spent the free plan's 100,000 requests a day (Cloudflare's 429, error 1027) in 5 hours.
const HOLD_MS = 25000;
const LOOK_MS = 5000;
// How long this location keeps its look at the build line (`queue`), and how often a job it can't
// place may make it look again. GitHub gives the token's owner 5,000 calls an hour for everything
// he and his tools do; the first day spent them all at 45 s and 10 s.
const QUEUE_SECONDS = 120;
const LOOK_AGAIN_SECONDS = 60;
// A job asked this long ago, neither in line nor building and with no answer, is taken as lost:
// its run ended without publishing (as when the results release was full).
const LOST_SECONDS = 600;
const DID_NOT_FINISH = "The build on GitHub did not finish. Try again.";

const JOB = /^[0-9a-f]{24}$/;
const VERSION = /^\d+(\.\d+){1,3}$/;

const NOT_HERE = "No such thing here.";
const YOUR_LIMIT = "You have compiled a lot today. Try again tomorrow.";
const EVERYONES_LIMIT = "The build service has done all it can today. Try again tomorrow.";
const UNAVAILABLE = "The build service can't reach GitHub right now. Try again later.";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    REPO = repoOf(env);
    try {
      if (request.method === "POST" && url.pathname === "/v1/build") {
        return await build(request, url, env, ctx);
      }
      if (request.method === "GET" && parts[0] === "v1" && parts[1] === "job" && JOB.test(parts[2] ?? "")) {
        if (parts.length === 3) return await status(parts[2], env, ctx);
        if (parts.length === 4 && parts[3] === "lib") return await library(parts[2], request);
      }
      return answer(404, { error: NOT_HERE });
    } catch (e) {
      console.log(`${request.method} ${url.pathname}: ${e?.stack ?? e}`);
      return answer(503, { error: UNAVAILABLE });
    }
  },
};

/** env.REPO when it is an "owner/name", else this service's own repository. */
export function repoOf(env) {
  const repo = String(env.REPO ?? "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : MAIN_REPO;
}

/** A new build of `version` with the body's mods, or the job that already has them. */
async function build(request, url, env, ctx) {
  const version = url.searchParams.get("version") ?? "";
  if (!VERSION.test(version)) return answer(400, { error: "That is not a version of the game." });
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY) return answer(413, { error: "That is too big to compile." });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length === 0 || body.length > MAX_BODY) {
    return answer(413, { error: "That is too big to compile." });
  }
  const commit = (await versions())[version];
  if (!commit) {
    return answer(400, {
      error: "This version of Starling can't compile mods any more. Update Starling.",
    });
  }
  const job = await jobOf(version, commit, body);
  // Built before, failing for good, or on its way: the job is all the game needs. A failure that
  // may pass another time (a machine that went away) is built again.
  if (await published(`${job}.json`, ctx)) return answer(200, { job });
  const failure = await failureOf(job, ctx);
  if (failure?.settled) return answer(200, { job });
  const asked = await recall(`asked/${job}`);
  if (asked && !(failure && (failure.at ?? 0) >= asked.at)) {
    // Still on its way, or not long enough asked to tell: the same job. One asked long ago and
    // gone from the line without an answer is built again.
    const gone = now() - asked.at > LOST_SECONDS && !(await running(job, env, ctx));
    if (!gone) return answer(200, { job });
  }
  const run = failure ? null : await running(job, env, ctx, false);
  if (run && !run.unknown) return answer(200, { job });

  const address = await hashed(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await count(`address/${address}`, PER_ADDRESS, ctx))) return answer(429, { error: YOUR_LIMIT });
  if (!(await count("everyone", PER_DAY, ctx))) return answer(429, { error: EVERYONES_LIMIT });

  const { sealed, key } = await seal(body);
  const ask = hex(crypto.getRandomValues(new Uint8Array(16)));
  await upload(env, ctx, REQUESTS, `${ask}.bin`, sealed);
  await github(env, "POST", `/actions/workflows/${WORKFLOW}/dispatches`, {
    ref: "main",
    inputs: { job, ask, key, version },
  });
  ctx.waitUntil(remember(`asked/${job}`, { at: now() }, LONGEST));
  return answer(200, { job });
}

/**
 * What the game shows while it waits, and the library's checksum once it is there. A job still on
 * its way is answered after HOLD_MS, or as soon as a look finds its answer: the game asks again
 * 2 s after each answer, so holding it makes every Starling, old ones too, ask over ten times less
 * while it waits (the free plan counts requests). Its read waits 40 s, beyond the hold.
 */
async function status(job, env, ctx) {
  const done = await published(`${job}.json`, ctx);
  if (done) return answer(200, done);
  const told = await waiting(job, env, ctx);
  const hold = Number(env.HOLD_MS ?? HOLD_MS);
  if (hold > 0 && (told?.state === "building" || told?.state === "queued")) {
    const step = Math.min(hold, Number(env.LOOK_MS ?? LOOK_MS));
    for (let held = 0; held < hold; held += step) {
      await new Promise((resolve) => setTimeout(resolve, step));
      const doneSince = await published(`${job}.json`, ctx);
      if (doneSince) return answer(200, doneSince);
      if (await failureOf(job, ctx)) {
        const since = await waiting(job, env, ctx);
        if (since?.state === "failed") return answer(200, since);
      }
    }
  }
  return told ? answer(200, told) : answer(404, { error: "No such job." });
}

/** A job not done: its failure or how it goes, or null when there is none. */
async function waiting(job, env, ctx) {
  const failure = await failureOf(job, ctx);
  const asked = await recall(`asked/${job}`);
  // A failure the build ran again since is old news.
  if (failure && !(asked && asked.at > (failure.at ?? 0))) {
    const { state, error, settled } = failure;
    return { state, error, settled: Boolean(settled) };
  }
  // Just asked here: at the end of the line, with no call (GitHub lists a run a little after it
  // is asked for, and the line read may be up to QUEUE_SECONDS old).
  if (asked && now() - asked.at < 120) {
    const line = await recall("queue");
    return { state: "queued", ahead: line?.value.queued.length ?? 0 };
  }
  const lost = asked && now() - asked.at > LOST_SECONDS;
  const run = await running(job, env, ctx, !asked || lost);
  if (run && !run.unknown) return run;
  // Asked long ago and neither in line nor building, with no answer: its run ended without
  // publishing one. The game is told so, and asking again builds it again.
  if (lost && !run) return { state: "failed", error: DID_NOT_FINISH, settled: false };
  if (!asked) {
    // GitHub can't be asked right now: the game tries again, not "lost".
    if (run?.unknown) throw new Error(`the line of ${job} can't be read`);
    return null;
  }
  // Whole seconds: the game reads them as an integer (`as_u64`), and a fraction reads as none.
  return { state: "building", seconds: Math.max(0, Math.floor(now() - asked.at)) };
}

/**
 * The finished library. A download that goes on from where it stopped (`Range: bytes=N-`, N > 0)
 * is sent to GitHub, which answers 206 with the rest. One from the start comes through here as a
 * 200: the game asks for it with `bytes=0-` and takes a 206 as more of a file it already has
 * (0.8.0's `fetch_library` opens it to append), and GitHub answers `bytes=0-` with 206, so a
 * redirect there failed every first download with "No such file or directory (os error 2)".
 */
async function library(job, request) {
  const name = `${job}.so`;
  const from = /^bytes=(\d+)-$/.exec(request.headers.get("Range") ?? "");
  if (from && Number(from[1]) > 0) {
    const shard = await fetch(`${downloads()}/${shardOf(name)}/${name}`, { method: "HEAD", redirect: "follow" });
    const tag = shard.status === 404 ? RESULTS : shardOf(name);
    return new Response(null, { status: 302, headers: { Location: `${downloads()}/${tag}/${name}` } });
  }
  const upstream = await fetchResult(name);
  if (upstream.status === 404) return answer(404, { error: "No such build. Compile again." });
  if (!upstream.ok) throw new Error(`${job}.so: ${upstream.status}`);
  const headers = { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" };
  const length = upstream.headers.get("Content-Length");
  if (length) headers["Content-Length"] = length;
  return new Response(upstream.body, { status: 200, headers });
}

/**
 * The release a build's files go to: a release holds 1000 assets at most, and the first evening
 * filled `results`, so builds are spread over results-0 to results-f by the job's first hex digit
 * (scripts/publish.py).
 */
function shardOf(name) {
  return `results-${name[0]}`;
}

/** One of a build's files: in its shard, or in `results`, where the first evening's builds are. */
async function fetchResult(name) {
  for (const tag of [shardOf(name), RESULTS]) {
    const response = await fetch(`${downloads()}/${tag}/${name}`, { redirect: "follow" });
    if (response.status !== 404) return response;
  }
  return new Response("Not Found", { status: 404 });
}

/** The job of these mods on this commit: the same mods ask for the same build. */
export async function jobOf(version, commit, body) {
  const asked = new TextEncoder().encode(`/v1/build?version=${version}&commit=${commit}`);
  const all = new Uint8Array(asked.length + body.length);
  all.set(asked);
  all.set(body, asked.length);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", all))).slice(0, 24);
}

/**
 * The body sealed with AES-256-CTR under a fresh key: `key` is the key's hex and then the counter
 * block's, as `openssl enc -aes-256-ctr -K -iv` takes them. The counter's low 64 bits start at
 * zero, so WebCrypto's 64-bit counter and OpenSSL's 128-bit one never part.
 */
export async function seal(body) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const counter = crypto.getRandomValues(new Uint8Array(16));
  counter.fill(0, 8);
  const key = await crypto.subtle.importKey("raw", raw, "AES-CTR", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-CTR", counter, length: 64 }, key, body);
  return { sealed: new Uint8Array(sealed), key: hex(raw) + hex(counter) };
}

/** versions.json: each version the service compiles, and its commit. */
async function versions() {
  const response = await fetch(`https://raw.githubusercontent.com/${REPO}/main/versions.json`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`versions.json: ${response.status}`);
  return response.json();
}

/**
 * One of the results release's JSON files, or null; kept here an hour once there (scripts/clean.py
 * deletes old builds), 15 s while not.
 */
async function published(name, ctx, seconds = 3600) {
  const key = `published/${name}`;
  const known = await recall(key);
  if (known) return known.value;
  const response = await fetchResult(name);
  if (response.status === 404) {
    ctx.waitUntil(remember(key, { value: null }, 15));
    return null;
  }
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  const value = await response.json();
  ctx.waitUntil(remember(key, { value }, seconds));
  return value;
}

/** The last failure published for `job`, which a new run replaces. */
function failureOf(job, ctx) {
  return published(`${job}.failed.json`, ctx, 30);
}

/** The job's run on GitHub when it is queued or going: what the game is told of it. */
async function running(job, env, ctx, mayLookAgain = true) {
  const title = `build ${job}`;
  try {
    let found = placeIn(await queue(env, ctx), title);
    // Not in the line as last seen: it moved since (from waiting to building, between two
    // looks), or that look came back short. Look again before calling it lost, at most every
    // LOOK_AGAIN_SECONDS here: a job told "No such job" is given up by the game.
    if (!found && mayLookAgain && !(await recall("queue-fresh"))) {
      await remember("queue-fresh", { at: now() }, LOOK_AGAIN_SECONDS);
      found = placeIn(await queue(env, ctx, true), title);
    }
    return found;
  } catch (e) {
    // GitHub refused (its hourly limit) or is down: where the job stands is unknown.
    console.log(`the line: ${e}`);
    return { unknown: true };
  }
}

/** Where `title` stands in the line `queue` read, or null when it is not in it. */
function placeIn({ queued, building }, title) {
  if (title in building) {
    return { state: "building", seconds: Math.max(0, Math.floor(now() - building[title])) };
  }
  const place = queued.indexOf(title);
  return place >= 0 ? { state: "queued", ahead: place } : null;
}

/**
 * The build workflow's line on GitHub: the jobs waiting, oldest first, and when each running one
 * began. Read once for everyone every QUEUE_SECONDS in this location, so a game in line learns
 * its place ("In line: N before yours") without a call of its own: GitHub gives a token 5,000 a
 * hour, and a busy hour has a hundred jobs in line asking every few seconds.
 */
async function queue(env, ctx, fresh = false) {
  const known = fresh ? null : await recall("queue");
  if (known) return known.value;
  const list = async (status) => {
    const runs = [];
    for (let page = 1; page <= 5; page++) {
      const { workflow_runs: some } = await github(
        env,
        "GET",
        `/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&status=${status}&per_page=100&page=${page}`,
      );
      runs.push(...some);
      if (some.length < 100) break;
    }
    return runs;
  };
  const queued = (await list("queued"))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .map((r) => r.display_title);
  const building = Object.fromEntries(
    (await list("in_progress")).map((r) => [
      r.display_title,
      Date.parse(r.run_started_at ?? r.created_at ?? "") / 1000 || now(),
    ]),
  );
  const value = { queued, building };
  ctx.waitUntil(remember("queue", { value }, QUEUE_SECONDS));
  return value;
}

/** Puts `bytes` in release `tag` as `name`. */
async function upload(env, ctx, tag, name, bytes) {
  const id = await releaseId(env, ctx, tag);
  const response = await fetch(
    `${UPLOADS}/repos/${REPO}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
    { method: "POST", headers: { ...(await headers(env)), "Content-Type": "application/octet-stream" }, body: bytes },
  );
  if (!response.ok) throw new Error(`upload ${tag}/${name}: ${response.status} ${await response.text()}`);
}

async function releaseId(env, ctx, tag) {
  const key = `release/${tag}`;
  const known = await recall(key);
  if (known) return known.value;
  const { id } = await github(env, "GET", `/releases/tags/${tag}`);
  ctx.waitUntil(remember(key, { value: id }, DAY));
  return id;
}

/** One call to the repository's API: its JSON, or null when it answers nothing. */
async function github(env, method, path, payload) {
  const response = await fetch(`${API}/repos/${REPO}${path}`, {
    method,
    headers: { ...(await headers(env)), ...(payload ? { "Content-Type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function headers(env) {
  return { ...plainHeaders(), Authorization: `Bearer ${await token(env)}` };
}

function plainHeaders() {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "starling-compile",
  };
}

// The GitHub App's installation token, while it lasts, in this isolate.
let installation = null;

/**
 * The token the service acts with. With the GitHub App (secrets GITHUB_APP_ID and GITHUB_APP_KEY,
 * the App's private key as PKCS#8 PEM; the App is installed on mod-builds alone), an installation
 * token: it has its own hourly limit, and the builds are the App's, not a person's (no failure
 * mails to the owner). Without it, GITHUB_TOKEN, a person's token, which shares that person's
 * 5,000 calls an hour with everything else they do.
 */
async function token(env) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_KEY) return env.GITHUB_TOKEN;
  if (installation && installation.until > now() + 120) return installation.token;
  const app = { ...plainHeaders(), Authorization: `Bearer ${await appJwt(env)}` };
  const listed = await fetch(`${API}/app/installations`, { headers: app });
  if (!listed.ok) throw new Error(`the App's installations: ${listed.status}`);
  const owner = REPO.split("/")[0];
  const id = (await listed.json()).find((i) => i.account?.login === owner)?.id;
  if (!id) throw new Error(`the App is not installed on ${owner}`);
  const made = await fetch(`${API}/app/installations/${id}/access_tokens`, { method: "POST", headers: app });
  if (!made.ok) throw new Error(`the App's token: ${made.status}`);
  const { token: value, expires_at: expires } = await made.json();
  installation = { token: value, until: Date.parse(expires) / 1000 };
  return value;
}

/** The App's own JWT (RS256, ten minutes at most), to ask for an installation token. */
async function appJwt(env) {
  const base64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const part = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const at = Math.floor(now());
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: at - 60, exp: at + 540, iss: String(env.GITHUB_APP_ID).trim() })}`;
  const der = Uint8Array.from(atob(env.GITHUB_APP_KEY.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) =>
    c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

/** Adds one to today's count of `name` unless it is at `limit`: whether it was below. */
async function count(name, limit, ctx) {
  const key = `count/${Math.floor(now() / DAY)}/${name}`;
  const known = await recall(key);
  const n = known?.value ?? 0;
  if (n >= limit) return false;
  ctx.waitUntil(remember(key, { value: n + 1 }, DAY));
  return true;
}

// This location's cache holds what is worth not asking GitHub again; keys are made-up URLs.
function cacheKey(name) {
  return new Request(`https://starling-compile.cache/${name}`);
}

async function recall(name) {
  const hit = await caches.default.match(cacheKey(name));
  return hit ? hit.json() : null;
}

function remember(name, value, seconds) {
  return caches.default.put(
    cacheKey(name),
    new Response(JSON.stringify(value), {
      headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${seconds}` },
    }),
  );
}

async function hashed(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32);
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function now() {
  return Date.now() / 1000;
}

function answer(code, body) {
  return new Response(JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
