// Test seam only: the shipped Idunn runtime (scripts/idunn-entry.mjs idunnRuntime) over a signer whose write lease is
// a file, so the lease gate is tested without Idunn's authority files. Present = leased. The daemon's own flags
// arrive on argv as they do for the hand-run daemon.
import { existsSync, appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { idunnRuntime } from "../idunn-entry.mjs";
import { serve } from "../vili-daemon.mjs";

const leasePath = process.env.FAKE_IDUNN_LEASE;
const healthLog = process.env.FAKE_IDUNN_HEALTH_LOG;
const answer = process.env.FAKE_IDUNN_ANSWER_THROWS !== "1";
// The lease is gone from the moment a path exists under the state root (one "*" segment matches any entry), so a
// test can lose it between two writes of one request.
const stateRoot = process.env.FAKE_IDUNN_STATE_ROOT;
const loseWhenExists = process.env.FAKE_IDUNN_LOSE_WHEN_EXISTS;

function exists(parts, base) {
  if (!parts.length) return true;
  const [head, ...rest] = parts;
  if (head !== "*") return existsSync(path.join(base, head)) && exists(rest, path.join(base, head));
  return existsSync(base) && readdirSync(base).some((entry) => exists(rest, path.join(base, entry)));
}

const signer = {
  assertWriteLease() {
    if (!existsSync(leasePath)) throw new Error("no lease");
    if (loseWhenExists && exists(loseWhenExists.split("/"), stateRoot)) throw new Error("lease lost");
    return "lease";
  },
  answerRouteObservation(request) {
    if (!answer) throw new Error("signer refused");
    return { schemaId: "fake.presence", recordKey: request.messageId, payload: new Uint8Array([1, 2, 3]) };
  },
  reportHealth(state) {
    appendFileSync(healthLog, `${state}\n`);
  },
};

await serve(idunnRuntime(signer, { pollMs: 200 }));
