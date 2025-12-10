import { isAuthenticated } from "@bittery/shared/crypto";
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/home")({
  component: RouteComponent,
  beforeLoad: () => {
    if (!isAuthenticated()) {
      throw redirect({ to: "/login" });
    }
  },
});

function RouteComponent() {
  return <h1>Home</h1>;
}
