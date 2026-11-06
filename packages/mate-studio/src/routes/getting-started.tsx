import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/getting-started")({
  ssr: true,
  staticData: { view: "getting-started" },
  component: Outlet,
});
