import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import { AGENT_METHODS } from "./_generated/meta.gen.ts";
import { AgentRpcs } from "./rpc.ts";

const rpc = AgentRpcs.requests.get(AGENT_METHODS.session_set_config_option);

it.effect("decodes a set_config_option response that omits configOptions", () =>
  Effect.gen(function* () {
    assert.isDefined(rpc);
    const decode = Schema.decodeUnknownEffect(rpc!.successSchema);
    // Factory Droid replies `{}` and reports the new state via config_option_update.
    const decoded = yield* decode({});
    assert.deepEqual(decoded.configOptions, []);
    const full = yield* decode({ configOptions: [] });
    assert.deepEqual(full.configOptions, []);
  }),
);
