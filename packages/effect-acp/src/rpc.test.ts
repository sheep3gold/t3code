import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";

import { AGENT_METHODS } from "./_generated/meta.gen.ts";
import { AgentRpcs, SetSessionConfigOptionResponseLenient } from "./rpc.ts";

const rpc = AgentRpcs.requests.get(AGENT_METHODS.session_set_config_option);

it.effect("decodes a set_config_option response that omits configOptions", () =>
  Effect.gen(function* () {
    assert.isDefined(rpc);
    const decode = Schema.decodeUnknownEffect(rpc!.successSchema);
    // Factory Droid replies `{}` and reports the new state via config_option_update.
    // Rpc 的静态分发把 successSchema 的类型落在别的响应上；按构造它就是
    // SetSessionConfigOptionResponseLenient，这里显式标注解码结果的类型。
    type LenientResponse = Schema.Schema.Type<typeof SetSessionConfigOptionResponseLenient>;
    const decoded = (yield* decode({})) as LenientResponse;
    assert.deepEqual(decoded.configOptions, []);
    const full = (yield* decode({ configOptions: [] })) as LenientResponse;
    assert.deepEqual(full.configOptions, []);
  }),
);
