import { createFileRoute } from "@tanstack/react-router";

import { MemoryLedgerManagementPage } from "../components/memory/MemoryLedgerManagementPage";

export const Route = createFileRoute("/memory")({
  component: MemoryLedgerManagementPage,
});
