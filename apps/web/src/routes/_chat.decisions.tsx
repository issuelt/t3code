import { createFileRoute } from "@tanstack/react-router";

import { DecisionsPage } from "../components/decisions/DecisionsPage";

export const Route = createFileRoute("/_chat/decisions")({
  component: DecisionsPage,
});
