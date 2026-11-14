import { createFileRoute } from "@tanstack/react-router";

import { FleetPage } from "../components/fleet/FleetPage";

export const Route = createFileRoute("/_chat/fleet")({
  component: FleetPage,
});
