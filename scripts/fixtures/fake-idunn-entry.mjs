// Test seam only: the shipped Idunn runtime (scripts/idunn-entry.mjs idunnRuntime) over a signer whose write lease is
// a file, so the lease gate is tested without Idunn's authority files. Present = leased. The daemon's own flags
// arrive on argv as they do for the hand-run daemon.
import { existsSync, appendFileSync } from "node:fs";
import { idunnRuntime } from "../idunn-entry.mjs";
import { serve } from "../vili-daemon.mjs";

const leasePath = process.env.FAKE_IDUNN_LEASE;
const healthLog = process.env.FAKE_IDUNN_HEALTH_LOG;
const answer = process.env.FAKE_IDUNN_ANSWER_THROWS !== "1";

const signer = {
  assertWriteLease() {
    if (!existsSync(leasePath)) throw new Error("no lease");
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
