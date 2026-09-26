import { describe, expect, it } from "vite-plus/test";

import { recoverableTurnRetryDelayMs } from "./ProviderRuntimeIngestion.ts";

describe("recoverable provider turn retry", () => {
  it("uses bounded backoff and stops after three attempts", () => {
    expect([1, 2, 3, 4].map(recoverableTurnRetryDelayMs)).toEqual([
      2_000,
      5_000,
      15_000,
      null,
    ]);
    expect(recoverableTurnRetryDelayMs(0)).toBeNull();
  });
});
