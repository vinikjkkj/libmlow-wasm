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
/**
 * Applied to the codec in both build paths so autotools and CMake stop
 * producing different binaries: autoconf defaults to `-g -O2`, shipping debug
 * info that the CMake path does not carry.
 *
 * Deliberately NOT `-O3`, `-flto` or `-DNDEBUG`. AGENTS.md records that
 * `-O3 -flto` through these flags made the first decode hang, and that the
 * `-DNDEBUG` variant hung as well. Measuring here also showed no speed gain
 * beyond trial noise from any of them, so there is nothing to weigh against
 * that risk. Optimisation stays where the known-good profile puts it: the
 * final `emcc -O3 -flto` at link time.
 */
const OPUS_RELEASE_CFLAGS = "-O2";

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
  "_oc_encode_secondary",
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
  "_oc_packet_info",
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
  "_oc_mlow_packet_info",
  "_oc_mlow_strip_padding_flag",
  "_oc_mlow_packet_parse_toc",
  "_oc_mlow_repacketize",
  "_oc_repacketizer_cat",
  "_oc_repacketizer_create",
  "_oc_repacketizer_destroy",
  "_oc_repacketizer_get_nb_frames",
  "_oc_repacketizer_init",
  "_oc_repacketizer_out",
  "_oc_repacketizer_out_range",
  "_oc_repacketizer_set_using_mlow",
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
    // Without CFLAGS, autoconf falls back to `-g -O2` and ships debug info.
    // No LDFLAGS: AGENTS.md rules out -flto through the codec's own flags.
    { cwd: buildDir, env: { CFLAGS: OPUS_RELEASE_CFLAGS } },
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
      // The Emscripten toolchain file overrides the Release flags (historically
      // to -O2), so set them explicitly. -flto here is what makes the -flto in
      // linkWrapper() do real work: without it the static lib ships as finished
      // wasm objects and the link-time LTO only sees the wrapper's thunks.
      `-DCMAKE_C_FLAGS_RELEASE=${OPUS_RELEASE_CFLAGS}`,
      // Left at the upstream default (ON), which compiles the SMPL DSP core with
      // -Os. Turning it off looked like the big win on paper, but measured it
      // moved encode by ~1% — inside trial noise — while adding 205 KB (+34%)
      // to the bundle. The -O3 wasm-opt pass at link time recovers the rest.
      `-DOPUS_REDUCE_SMPL_BINARY_SIZE=${boolFlag("LIBMLOW_WASM_SMPL_FULL_OPT") === "ON" ? "OFF" : "ON"}`,
      // Opt-in: unlocks the -Ofast the codec already marks for its eight
      // hottest files. Fast, but the output stops being bit-exact and the
      // float approximations also reach the plain Opus rate control, so it is
      // off until someone runs test vectors against it.
      `-DOPUS_FLOAT_APPROX=${boolFlag("LIBMLOW_WASM_FLOAT_APPROX")}`,
      // Opt-in: drops the SMPL asserts, but also validate_opus_decoder and
      // validate_celt_decoder, which guard against malformed packets. This
      // library decodes bytes off the network, so it stays on by default.
      `-DOPUS_HARDENING=${boolFlag("LIBMLOW_WASM_HARDENING", true)}`,
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
      // Kept at 8 MB per AGENTS.md ("STACK_SIZE=8388608 for SMPL stack depth").
      // A static trace suggested ~140 KB was the deepest use, but that trace did
      // not exercise SMPL, and the note records a measured requirement.
      "-s",
      "STACK_SIZE=8388608",
      // No INITIAL_MEMORY override: it has to exceed STACK_SIZE, and the 8 MB
      // stack above leaves the Emscripten default as the smallest legal choice
      // anyway.
      // The hot path never allocates (Opus uses stack VLAs; the JS side caches
      // its scratch pointers), so the simpler allocator is enough.
      "-s",
      "MALLOC=emmalloc",
      "-s",
      "FILESYSTEM=0",
      // Drops eval/new Function, which makes the module usable under a strict CSP.
      "-s",
      "DYNAMIC_EXECUTION=0",
      "-s",
      "INCOMING_MODULE_JS_API=[]",
      "-s",
      "TEXTDECODER=2",
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

/** Reads an opt-in build switch from the environment, as ON/OFF for CMake. */
function boolFlag(name, defaultOn = false) {
  const value = process.env[name];
  if (value === undefined) {
    return defaultOn ? "ON" : "OFF";
  }
  return value === "1" || value.toLowerCase() === "on" ? "ON" : "OFF";
}

function cpuCount() {
  return Math.max(1, Math.min(8, Number(process.env.LIBMLOW_WASM_BUILD_JOBS) || 4));
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const { env: extraEnv, ...spawnOptions } = options ?? {};
    const child = spawn(command, args, {
      ...spawnOptions,
      env: { ...toolchainEnv(), ...extraEnv },
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
