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
const documentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/documents/$",
  component: function DocumentRoute() {
    const { _splat } = documentRoute.useParams();
    return (
      <Atlas selection={{ kind: "document", path: _splat ?? "index.md" }} />
    );
  },
});
const rootFolderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/folders",
  component: () => <Atlas selection={{ kind: "folder", path: "" }} />,
});
const folderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/folders/$",
  component: function FolderRoute() {
    const { _splat } = folderRoute.useParams();
    return <Atlas selection={{ kind: "folder", path: _splat ?? "" }} />;
  },
});
const routeTree = rootRoute.addChildren([
  homeRoute,
  documentRoute,
  rootFolderRoute,
  folderRoute,
]);
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
