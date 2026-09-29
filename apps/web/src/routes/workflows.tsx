import { createFileRoute } from "@tanstack/react-router";

import { WorkflowManagementPage } from "../components/workflows/WorkflowManagementPage";

export const Route = createFileRoute("/workflows")({
  component: WorkflowManagementPage,
});
