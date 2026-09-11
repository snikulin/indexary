import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Atlas } from "./atlas";
import "./styles.css";

const rootRoute = createRootRoute({ component: Outlet });
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Atlas,
});
const routeTree = rootRoute.addChildren([homeRoute]);
const router = createRouter({ routeTree });
const queryClient = new QueryClient();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Indexary root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
