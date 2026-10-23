#!/usr/bin/env node
// The Idunn entry: the process Idunn's unit runs for target "vili". Idunn owns Vili's lifecycle and hands it one
// writer authority, the process write lease. This file turns Idunn's environment into the daemon's own
// configuration and into the runtime port serve() takes; it adds no routes and decides nothing the daemon decides.
//
//   node vili/scripts/idunn-entry.mjs --state-root <absolute> --kimodo-commit <40 hex>
//
// Nothing from the bundle, the activation or the identity reaches the worker: the daemon's childEnv forwards only
// PATH, HOME and LANG besides its own VILI_* settings.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decode, encode } from "@msgpack/msgpack";
import { encodeCultNetMessageForWire, parseCultNetMessage } from "cultnet-ts";
import { createIdunnRuntimeSigner, loadIdunnRuntimeAuthorityFromEnvironment } from "cultnet-ts/idunn-runtime";

const HEALTH_CONTRACT = "gamecult.runtime_presence_health.v2";
const LEASE_POLL_MS = 5000;
const here = path.dirname(fileURLToPath(import.meta.url));

// The runtime port serve() takes, over an Idunn runtime signer. Exported so the lease gate is tested against the
// code that ships, with a signer whose lease is a file (scripts/fixtures/fake-idunn-entry.mjs).
export function idunnRuntime(signer, { pollMs = LEASE_POLL_MS } = {}) {
  let held = false;
  let lost = false;

  return {
    async acquire() {
      for (;;) {
        try {
          signer.assertWriteLease();
          held = true;
          return;
        } catch {
          // Idunn has not leased this incarnation yet
        }
        await delay(pollMs);
      }
    },
    held: () => held,
    refusal: () => (lost ? "write-lease-lost" : "write-lease-pending"),
    watch(onLost) {
      if (!held) return;
      try {
        signer.assertWriteLease();
      } catch {
        held = false;
        lost = true;
        onLost();
      }
    },
    recordWorker() {},
    forgetWorker() {},
    answerSnapshot(bytes) {
      let request;
      try {
        request = parseCultNetMessage(decode(bytes), "cultnet.schema.v0");
        if (request.schemaVersion !== "cultnet.snapshot_request.v0") throw new Error("not a snapshot request");
      } catch {
        throw Object.assign(new Error("invalid snapshot request"), { code: "invalid-snapshot-request" });
      }
      const document = signer.answerRouteObservation(request);
      const response = {
        schemaVersion: "cultnet.snapshot_response_raw.v0",
        messageId: request.messageId,
        documents: [document],
      };
      return Buffer.from(encode(encodeCultNetMessageForWire(response, "cultnet.schema.v0")));
    },
    reportHealth: (state) => signer.reportHealth(state),
    release() {},
  };
}

function fail(reason) {
  console.error(`vili idunn entry: ${reason}`);
  process.exit(2);
}

// host:port, with an optional http:// scheme, as Idunn writes the candidate bind.
function splitBind(bind) {
  const match = /^(?:http:\/\/)?([^:/\s]+):(\d{1,5})\/?$/u.exec(bind ?? "");
  if (!match || Number(match[2]) > 65535) fail("GAMECULT_IDUNN_CANDIDATE_BIND is not host:port");
  return { host: match[1], port: match[2] };
}

function parseEntryArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--state-root" || argv[2] !== "--kimodo-commit") {
    fail("arguments must be exactly --state-root <absolute> --kimodo-commit <40 hex>");
  }
  if (!path.isAbsolute(argv[1])) fail("--state-root must be absolute");
  if (!/^[0-9a-f]{40}$/u.test(argv[3])) fail("--kimodo-commit must be 40 lowercase hex characters");
}

async function main() {
  parseEntryArgs(process.argv.slice(2));
  const { host, port } = splitBind(process.env.GAMECULT_IDUNN_CANDIDATE_BIND);
  const locks = ["requirements-build.lock", "requirements.lock"].map((name) =>
    readFileSync(path.resolve(here, "..", "deployment", "idunn", name)));
  process.env.VILI_DAEMON_HOST = host;
  process.env.VILI_DAEMON_PORT = port;
  process.env.VILI_PYTHON = path.resolve(here, "..", "..", "python", "bin", "python3.12");
  process.env.VILI_PYTHON_ENV = `locks-sha256:${createHash("sha256").update(Buffer.concat(locks)).digest("hex")}`;

  const authority = loadIdunnRuntimeAuthorityFromEnvironment("vili", HEALTH_CONTRACT);
  const signer = createIdunnRuntimeSigner({
    authority,
    capabilities: [{ capability: "vili.motion.api", schema: "http.v1", compatibility: "v1", capacity: 1 }],
  });
  if (!signer.requiresWriteLease) fail("Idunn declares no write lease for this runtime");

  const { serve } = await import("./vili-daemon.mjs");
  await serve(idunnRuntime(signer));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`vili idunn entry failed: ${error?.name || "Error"}`);
    process.exit(1);
  });
}
