import { createFileRoute } from "@tanstack/react-router";

import { ScheduleTimelinePage } from "../components/schedules/ScheduleTimelinePage";

export const Route = createFileRoute("/schedules")({
  component: ScheduleTimelinePage,
});
