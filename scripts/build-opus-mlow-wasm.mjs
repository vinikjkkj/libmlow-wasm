import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const opusRelease = "1.0.1";
const opusTarball = `opus-mlow-${opusRelease}.tar.gz`;
const opusUrl = `https://github.com/edgardmessias/opus_mlow/releases/download/v${opusRelease}/${opusTarball}`;
const opusSha256 = "2b730f9ccbc13b02b9360e889079ef2ca831cbf181fa8cb2dae634f532f76ca0";
const cacheDir = path.join(repoRoot, ".cache");
const sourceDir = path.join(cacheDir, `opus-mlow-${opusRelease}`);
const buildDir = path.join(cacheDir, `opus-mlow-${opusRelease}-build`);
const generatedDir = path.join(repoRoot, "src", "generated");
const outputPath = path.join(generatedDir, "libmlow.generated.mjs");
const useCmake = process.platform === "win32" || process.env.LIBMLOW_WASM_BUILD_CMAKE === "1";

const exportedFunctions = [
  "_free",
  "_malloc",
  "_oc_create_decoder",
  "_oc_create_encoder",
  "_oc_decode",
  "_oc_decode_float",
  "_oc_destroy_decoder",
  "_oc_destroy_encoder",
  "_oc_encode",
  "_oc_encode_float",
  "_oc_decoder_ctl",
  "_oc_encoder_ctl",
  "_oc_encoder_ctl_get_bitrate",
  "_oc_encoder_ctl_get_in_dtx",
  "_oc_encoder_ctl_get_lookahead",
  "_oc_global_create",
  "_oc_global_free",
  "_oc_get_version_string",
  "_oc_packet_get_bandwidth",
  "_oc_packet_get_nb_channels",
  "_oc_packet_get_nb_frames",
  "_oc_packet_get_nb_samples",
  "_oc_packet_get_samples_per_frame",
  "_oc_packet_parse",
  "_oc_packet_validate_decode",
  "_oc_mlow_packet_get_bandwidth",
  "_oc_mlow_packet_get_nb_channels",
  "_oc_mlow_packet_get_nb_frames",
  "_oc_mlow_packet_get_nb_samples",
  "_oc_mlow_packet_get_samples_per_frame",
  "_oc_mlow_packet_parse",
  "_oc_mlow_packet_has_vad_flag",
  "_oc_mlow_packet_has_fec_content",
  "_oc_mlow_packet_parse_toc",
  "_oc_strerror",
];

await fs.mkdir(cacheDir, { recursive: true });
await fs.mkdir(generatedDir, { recursive: true });
await ensureOpusSource();

await fs.rm(buildDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true });

const { libPath, includeDirs } = useCmake ? await buildWithCmake() : await buildWithAutotools();
await linkWrapper(libPath, includeDirs);

console.log(`built ${path.relative(repoRoot, outputPath)} from opus_mlow ${opusRelease}`);

async function ensureOpusSource() {
  if (await exists(path.join(sourceDir, "configure"))) {
    return;
  }
  const tarballPath = path.join(cacheDir, opusTarball);
  await downloadFile(opusUrl, tarballPath);
  await verifySha256(tarballPath, opusSha256);
  await run("tar", ["-xzf", tarballPath, "-C", cacheDir], { cwd: repoRoot });
}

async function buildWithAutotools() {
  await run(
    "emconfigure",
    [
      path.join(sourceDir, "configure"),
      "--disable-doc",
      "--disable-extra-programs",
      "--disable-shared",
      "--enable-static",
      "--host=wasm32-unknown-emscripten",
    ],
    { cwd: buildDir },
  );
  await run("emmake", ["make", "-j", String(cpuCount())], { cwd: buildDir });

  return materializeStaticLib(path.join(buildDir, ".libs", "libopus.a"));
}

async function buildWithCmake() {
  await run(
    "emcmake",
    [
      "cmake",
      "-S",
      sourceDir,
      "-B",
      buildDir,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DOPUS_BUILD_TESTING=OFF",
      "-DOPUS_BUILD_PROGRAMS=OFF",
      "-DOPUS_BUILD_SHARED_LIBRARY=OFF",
      "-DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF",
      "-DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF",
      "-G",
      "Unix Makefiles",
    ],
    { cwd: repoRoot },
  );
  await run("emmake", ["cmake", "--build", buildDir, "--target", "opus", "-j", String(cpuCount())], {
    cwd: repoRoot,
  });

  return materializeStaticLib(path.join(buildDir, "libopus.a"));
}

async function materializeStaticLib(upstreamLibPath) {
  const libPath = path.join(buildDir, "libmlow.a");
  await fs.copyFile(upstreamLibPath, libPath);
  const includeDirs = useCmake
    ? [buildDir, path.join(sourceDir, "include")]
    : [path.join(buildDir, "include"), path.join(sourceDir, "include")];
  return { libPath, includeDirs };
}

async function linkWrapper(libPath, includeDirs) {
  const includeFlags = includeDirs.flatMap((dir) => ["-I", dir]);
  await run(
    "emcc",
    [
      "-O3",
      "-flto",
      ...includeFlags,
      path.join(repoRoot, "native", "mlow_wasm_wrapper.c"),
      libPath,
      "-o",
      outputPath,
      "-s",
      "ALLOW_MEMORY_GROWTH=1",
      "-s",
      "ASSERTIONS=0",
      "-s",
      "STACK_SIZE=8388608",
      "-s",
      "ENVIRONMENT=web,node",
      "-s",
      "EXPORT_ES6=1",
      "-s",
      `EXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
      "-s",
      'EXPORTED_RUNTIME_METHODS=["HEAP16","HEAP32","HEAPF32","HEAPU8","UTF8ToString"]',
      "-s",
      "MODULARIZE=1",
      "-s",
      "SINGLE_FILE=1",
    ],
    { cwd: repoRoot },
  );
}

function resolveEmsdkRoot() {
  if (process.env.EMSDK) {
    return process.env.EMSDK;
  }
  if (process.env.LIBMLOW_WASM_EMSDK) {
    return process.env.LIBMLOW_WASM_EMSDK;
  }
  const windowsDefault = "C:\\bin\\emsdk";
  if (process.platform === "win32" && existsSync(windowsDefault)) {
    return windowsDefault;
  }
  return "";
}

function toolchainEnv() {
  const emsdk = resolveEmsdkRoot();
  if (!emsdk) {
    return { ...process.env };
  }

  const emscripten = path.join(emsdk, "upstream", "emscripten");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "Path";
  const currentPath = process.env[pathKey] ?? "";
  return {
    ...process.env,
    EMSDK: emsdk.replace(/\\/g, "/"),
    [pathKey]: [emsdk, emscripten, currentPath].filter(Boolean).join(path.delimiter),
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadFile(url, destination) {
  if (await exists(destination)) {
    return;
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const data = new Uint8Array(await response.arrayBuffer());
  await fs.writeFile(destination, data);
}

async function verifySha256(filePath, expected) {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  const actual = hash.digest("hex");
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${path.basename(filePath)}: ${actual}`);
  }
}

function cpuCount() {
  return Math.max(1, Math.min(8, Number(process.env.LIBMLOW_WASM_BUILD_JOBS) || 4));
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      env: toolchainEnv(),
      stdio: "inherit",
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT" && ["emcc", "emcmake", "emconfigure", "emmake"].includes(command)) {
        reject(
          new Error(
            `${command} not found. Activate Emscripten (emsdk_env) or set EMSDK / LIBMLOW_WASM_EMSDK.`,
          ),
        );
        return;
      }
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed with ${signal ?? code}`));
    });
  });
}
