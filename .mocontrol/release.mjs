import { createHash } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
const env = process.env;
const version = env.RELEASE_VERSION;
const platform = env.RELEASE_PLATFORM ?? "macos";
if (!["macos", "windows"].includes(platform))
  throw new Error("Invalid release platform");
const architecture = platform === "macos" ? "arm64" : "x64";
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ""))
  throw new Error("Invalid release version");
const origin = new URL(env.MOCONTROL_RELEASE_URL);
if (origin.protocol !== "https:")
  throw new Error("HTTPS release service required");
const base = `${origin.origin}/v1/orgs/${encodeURIComponent(env.MOCONTROL_ORGANIZATION_ID)}/apps/${encodeURIComponent(env.MOCONTROL_APP_ID)}/releases`;
async function call(operation, fields = {}) {
  const oidcUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  oidcUrl.searchParams.set("audience", origin.origin);
  const oidc = await fetch(oidcUrl, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!oidc.ok) throw new Error("GitHub identity unavailable");
  const token = (await oidc.json()).value;
  const response = await fetch(`${base}/${operation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MOCONTROL_RELEASE_TOKEN}`,
      "X-GitHub-OIDC": token,
    },
    body: JSON.stringify({
      version,
      platform,
      architecture,
      notes: env.RELEASE_NOTES ?? "",
      dispatchId: env.RELEASE_DISPATCH_ID ?? "",
      ...fields,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(`Release service ${operation} failed (${response.status})`);
  return response.json();
}
const command = process.argv[2];
if (command === "register") await call("register");
else if (["building", "signing", "failed", "cancelled"].includes(command))
  await call("progress", { state: command });
else if (command === "prepare") {
  if (platform === "macos") {
    for (const key of [
      "MAC_CERTIFICATE",
      "MACOS_SIGNING_P12_PASSWORD",
      "MACOS_CODESIGN_IDENTITY",
      "MACOS_TEAM_ID",
      "MACOS_APPLE_ID",
      "MACOS_APPLE_PASSWORD",
      "MACOS_SIGNING_P12_PATH",
    ]) {
      if (!env[key]) throw new Error(`Missing signing input ${key}`);
    }
    await writeFile(
      env.MACOS_SIGNING_P12_PATH,
      Buffer.from(env.MAC_CERTIFICATE, "base64"),
      {
        mode: 0o600,
      },
    );
  } else {
    for (const key of [
      "AZURE_SIGNING_ENDPOINT",
      "AZURE_SIGNING_ACCOUNT_NAME",
      "AZURE_SIGNING_PROFILE_NAME",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_SECRET",
    ])
      if (!env[key]) throw new Error(`Missing signing input ${key}`);
  }
  const config = JSON.parse(await readFile("mobrowser.conf.json", "utf8"));
  const [major, minor, patch] = version.split(".");
  config.app.version = { major, minor, patch };
  await writeFile("mobrowser.conf.json", JSON.stringify(config, null, 2));
} else if (command === "publish") {
  const directory =
    platform === "macos"
      ? "build/dist/mac-arm64/pack"
      : "build/dist/win-x64/pack";
  const extension = platform === "macos" ? "dmg" : "exe";
  const files = (await readdir(directory)).filter(
    (name) => name.endsWith(`.${extension}`) && !name.startsWith("rw."),
  );
  if (files.length !== 1)
    throw new Error("Expected exactly one signed installer");
  const file = `${directory}/${files[0]}`;
  const md5 = createHash("md5"),
    sha256 = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    md5.update(chunk);
    sha256.update(chunk);
  }
  const artifact = {
    filename: `app-${version}-${platform}-${architecture}.${extension}`,
    size: (await stat(file)).size,
    md5: md5.digest("hex"),
    sha256: sha256.digest("hex"),
    platform,
    architecture,
  };
  const upload = await call("upload", { artifact });
  const response = await fetch(upload.url, {
    method: "PUT",
    headers: { ...upload.headers, "Content-Length": String(artifact.size) },
    body: createReadStream(file),
    duplex: "half",
    signal: AbortSignal.timeout(900000),
  });
  if (!response.ok && response.status !== 412)
    throw new Error(`Artifact upload failed (${response.status})`);
  let published;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      published = await call("finalize");
      break;
    } catch {
      if (attempt === 3)
        throw new Error("Publication pending; check MoControl");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (published?.state !== "published")
    throw new Error("Artifact was not published");
  console.log(`Published ${version}: ${published.downloadUrl}`);
} else throw new Error("Unknown release command");
